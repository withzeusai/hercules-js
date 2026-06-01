import type { DataModelFromSchemaDefinition, GenericQueryCtx } from "convex/server";
import {
  actionMatches,
  isOwnerOnlyLever,
  WILDCARD_ACTION,
  type ApplicableEntry,
  type WildcardMode,
} from "./authz";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

const DEFAULT_SCOPE_SENTINEL = "__hercules_default_scope__";
const ALL_RESOURCES_OBJECT_ID = "*";

type PermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
};

type CatalogPermission = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
};

// A canonical entry that also carries the catalog permissionId it was derived
// from (when it maps to one). The id lets getEffectivePermissions report a
// permission by set-membership — matching the canonical platform query
// (selectEffectivePermissionsByPrincipalIds) — rather than re-evaluating each
// catalog permission with its own action (which under-reports manage/`*`
// permissions, since requests never carry those superset tokens). The
// evaluator (evaluateAccess) ignores this extra field.
type RuntimeEntry = ApplicableEntry & { permissionId?: string };

export type EffectiveAccessEvaluation = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  scopeId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  // The full catalog and the assembled entries are returned as raw materials so
  // getEffectivePermissions can enumerate the principal's permissions lazily.
  // The hot authorize() path never enumerates — it resolves the single
  // requested permission and evaluates it directly — so the O(catalog) sweep is
  // not paid on every can() check.
  catalogPermissions: CatalogPermission[];
  // §0b: the principal's resolved wildcard mode (Owner short-circuits, Admin
  // allow-all-minus-levers). Surfaced so getEffectivePermissions can report a
  // future-inclusive set rather than under-reporting wildcard roles.
  wildcard: WildcardMode;
  // Canonical entries assembled from every layer (role contributions, direct
  // grants, resource grants), each carrying (resourceType, action) so the
  // checks entrypoint can run evaluateAccess for a concrete request, plus the
  // permissionId used by enumeratePermissions for membership reporting.
  entries: RuntimeEntry[];
};

export async function evaluateEffectiveAccess(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    tokenIdentifier?: string;
    scopeId?: string;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<EffectiveAccessEvaluation> {
  if (!args.tokenIdentifier) {
    return deny("missing_identity");
  }

  const token = parseTokenIdentifier(args.tokenIdentifier);
  if (!token) {
    return deny("invalid_identity");
  }

  const state = await ctx.db.query("sync_state").unique();
  if (!state) {
    return deny("mirror_not_ready");
  }
  if (token.issuer !== state.expectedIssuer) {
    return deny("unexpected_issuer");
  }
  if (!args.scopeId) {
    return deny("scope_missing", state.sourceVersion);
  }

  const defaultScope = await ctx.db
    .query("scopes")
    .withIndex("by_kind", (q) => q.eq("kind", "default"))
    .unique();
  if (!defaultScope) {
    return deny("default_scope_missing", state.sourceVersion);
  }

  const effectiveScopeId =
    args.scopeId === DEFAULT_SCOPE_SENTINEL ? defaultScope.accessScopeId : args.scopeId;
  const scope =
    effectiveScopeId === defaultScope.accessScopeId
      ? defaultScope
      : await ctx.db
          .query("scopes")
          .withIndex("by_scope_id", (q) => q.eq("accessScopeId", effectiveScopeId))
          .unique();
  if (!scope) {
    return deny("scope_missing", state.sourceVersion);
  }
  if (scope.status === "disabled") {
    return deny("scope_disabled", state.sourceVersion);
  }

  const principal = await ctx.db
    .query("principals")
    .withIndex("by_scope_auth_user", (q) =>
      q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", token.subject),
    )
    .unique();
  if (!principal) {
    return deny("principal_missing", state.sourceVersion);
  }
  if (principal.status !== "active") {
    return deny(`principal_${principal.status}`, state.sourceVersion, principal.principalId);
  }

  const catalogPermissions = await ctx.db
    .query("permissions")
    .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScope.accessScopeId))
    .collect();
  // permissionId -> (resourceType, action) lookup for translating role and
  // direct-permission grants (which reference a permissionId) into canonical
  // entries.
  const permissionById = new Map(
    catalogPermissions.map((permission) => [
      permission.permissionId,
      { resourceType: permission.resourceType, action: permission.action },
    ]),
  );

  const principalIds = await collectPrincipalIds(ctx, {
    principalId: principal.principalId,
    scopeId: scope.accessScopeId,
  });

  const grantContributions = await collectGrantContributions(ctx, {
    principalIds,
    scopeId: scope.accessScopeId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    permissionById,
  });

  // §0b: resolve the principal's wildcard mode from its effective roles.
  // immutable (Owner) dominates default (Admin) dominates none.
  const wildcard = await resolvePrincipalWildcard(ctx, grantContributions.roleIds);

  // Role-permission rows resolve to a net {allow, deny} contribution per role
  // (allow adds / deny removes, org-scope override layered on top). The net
  // allow set is emitted as type-level allow entries. For an un-narrowed Admin
  // (wildcard "default"), its net deny set is also emitted as type-level deny
  // entries so an explicit narrowing deny short-circuits at authz step 3 before
  // the Admin default-allow at step 4 — mirroring the canonical query.ts deny
  // subtraction. (For "none" roles the deny set is a pure within-role override
  // already folded into the allow set, so it need not be emitted; Owner is
  // immutable and short-circuits, so its deny is moot.) The cross-layer
  // deny-override (authz step 3) is otherwise driven by direct-permission and
  // resource deny grants, which short-circuit globally.
  const roleEntries = await collectRolePermissionEntries(ctx, {
    roleIds: grantContributions.roleIds,
    targetScopeId: scope.accessScopeId,
    defaultScopeId: defaultScope.accessScopeId,
    permissionById,
  });

  // A role granted on a single resource instance (relationKind="role" +
  // objectType="resource") grants that role's permission set, but scoped to
  // the instance. Expand each such grant's role contribution into
  // instance-level entries (mirroring collectRolePermissionEntries, then
  // re-targeting from type-level to the specific objectId).
  const resourceRoleEntries = await collectResourceRoleEntries(ctx, {
    grants: grantContributions.resourceRoleGrants,
    targetScopeId: scope.accessScopeId,
    defaultScopeId: defaultScope.accessScopeId,
    permissionById,
  });

  const entries: RuntimeEntry[] = [
    ...roleEntries,
    ...resourceRoleEntries,
    ...grantContributions.entries,
  ];

  return {
    allowed: true,
    reasonCode: "allowed",
    sourceVersion: state.sourceVersion,
    scopeId: scope.accessScopeId,
    principalId: principal.principalId,
    effectiveRoleIds: grantContributions.roleIds,
    catalogPermissions: catalogPermissions.map((permission) => ({
      permissionId: permission.permissionId,
      key: permission.key,
      resourceType: permission.resourceType,
      action: permission.action,
    })),
    wildcard,
    entries,
  };
}

/**
 * Enumerate the catalog permissions this principal can exercise, by set-
 * membership over the assembled entries — matching the canonical platform query
 * (selectEffectivePermissionsByPrincipalIds). A catalog permission is reported
 * when:
 *   - Owner (immutable) → always (the whole catalog).
 *   - Admin (default)   → unless it is an Owner-only lever or is denied by a
 *     matching deny entry (a narrowing role-permission deny or a direct/resource
 *     deny).
 *   - else / additionally → there is an allow entry carrying this permissionId
 *     that matches the request scope (instance objectId when resource args are
 *     supplied) and no matching deny entry overrides it.
 *
 * Reporting by permissionId rather than re-running the evaluator with the
 * permission's own action is required so a manage/`*` permission held via a
 * role or direct grant is reported (the evaluator never matches a manage/`*`
 * request, since requests carry only concrete verbs).
 */
export function enumeratePermissions(
  catalogPermissions: CatalogPermission[],
  wildcard: WildcardMode,
  entries: RuntimeEntry[],
  args: { resourceId?: string },
): PermissionSummary[] {
  // A deny overrides an allow for the same catalog permission (deny-overrides
  // per §0.4), matching the canonical permissionId-based subtraction. The only
  // deny without a permissionId is the all-actions (`*`) deny emitted for a
  // wildcard role granted on a single resource instance; it overrides by
  // resourceType + action-superset at its own objectId.
  const denies = entries.filter((entry) => entry.effect === "deny");
  const isDenied = (permission: CatalogPermission): boolean =>
    denies.some((entry) => {
      if (entry.objectType === "resource" && entry.objectId !== args.resourceId) return false;
      if (entry.permissionId !== undefined) return entry.permissionId === permission.permissionId;
      return (
        (entry.resourceType === WILDCARD_ACTION ||
          entry.resourceType === permission.resourceType) &&
        actionMatches(entry.action, permission.action)
      );
    });

  // permissionIds backed by a matching allow entry at the request scope.
  const allowedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.effect !== "allow" || entry.permissionId === undefined) continue;
    if (entry.objectType === "resource" && entry.objectId !== args.resourceId) continue;
    allowedIds.add(entry.permissionId);
  }

  return catalogPermissions
    .filter((permission) => {
      if (isDenied(permission)) return false;
      if (wildcard === "immutable") return true;
      if (
        wildcard === "default" &&
        !isOwnerOnlyLever({ resourceType: permission.resourceType, action: permission.action })
      ) {
        return true;
      }
      return allowedIds.has(permission.permissionId);
    })
    .map((permission) => ({
      permissionId: permission.permissionId,
      key: permission.key,
      resourceType: permission.resourceType,
      action: permission.action,
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));
}

function parseTokenIdentifier(tokenIdentifier: string) {
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    return null;
  }
  return {
    issuer: tokenIdentifier.slice(0, separatorIndex),
    subject: tokenIdentifier.slice(separatorIndex + 1),
  };
}

async function collectPrincipalIds(
  ctx: GenericQueryCtx<DataModel>,
  args: { principalId: string; scopeId: string },
) {
  const principalIds = new Set([args.principalId]);
  const memberships = await ctx.db
    .query("principal_memberships")
    .withIndex("by_member", (q) =>
      q.eq("accessScopeId", args.scopeId).eq("memberPrincipalId", args.principalId),
    )
    .collect();
  for (const membership of memberships) {
    principalIds.add(membership.groupPrincipalId);
  }
  return [...principalIds];
}

type PermissionLookup = Map<string, { resourceType: string; action: string }>;

type ResourceRoleGrant = {
  roleId: string;
  effect: "allow" | "deny";
  objectId: string;
  objectResourceType?: string;
};

async function collectGrantContributions(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    principalIds: string[];
    scopeId: string;
    resourceType?: string;
    resourceId?: string;
    permissionById: PermissionLookup;
  },
) {
  const now = Date.now();
  const roleIds = new Set<string>();
  const entries: RuntimeEntry[] = [];
  const resourceRoleGrants: ResourceRoleGrant[] = [];

  for (const principalId of args.principalIds) {
    const scopeGrants = await ctx.db
      .query("grants")
      .withIndex("by_subject_principal_object", (q) =>
        q
          .eq("subjectPrincipalId", principalId)
          .eq("objectType", "scope")
          .eq("objectId", args.scopeId),
      )
      .collect();
    collect(scopeGrants);

    if (args.resourceType && args.resourceId) {
      const specificGrants = await ctx.db
        .query("grants")
        .withIndex("by_subject_principal_scope_object_resource", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("objectScopeId", args.scopeId)
            .eq("objectType", "resource")
            .eq("objectResourceType", args.resourceType!)
            .eq("objectId", args.resourceId!),
        )
        .collect();
      collect(specificGrants);

      if (args.resourceId !== ALL_RESOURCES_OBJECT_ID) {
        const allResourceGrants = await ctx.db
          .query("grants")
          .withIndex("by_subject_principal_scope_object_resource", (q) =>
            q
              .eq("subjectPrincipalId", principalId)
              .eq("objectScopeId", args.scopeId)
              .eq("objectType", "resource")
              .eq("objectResourceType", args.resourceType!)
              .eq("objectId", ALL_RESOURCES_OBJECT_ID),
          )
          .collect();
        collect(allResourceGrants);
      }
    }
  }

  const effectiveRoleIds = [];
  for (const roleId of roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (role) effectiveRoleIds.push(roleId);
  }

  if (args.resourceType && args.resourceId) {
    for (const roleId of effectiveRoleIds) {
      const specificGrants = await ctx.db
        .query("grants")
        .withIndex("by_subject_role_scope_object_resource", (q) =>
          q
            .eq("subjectRoleId", roleId)
            .eq("objectScopeId", args.scopeId)
            .eq("objectType", "resource")
            .eq("objectResourceType", args.resourceType!)
            .eq("objectId", args.resourceId!),
        )
        .collect();
      collect(specificGrants);

      if (args.resourceId !== ALL_RESOURCES_OBJECT_ID) {
        const allResourceGrants = await ctx.db
          .query("grants")
          .withIndex("by_subject_role_scope_object_resource", (q) =>
            q
              .eq("subjectRoleId", roleId)
              .eq("objectScopeId", args.scopeId)
              .eq("objectType", "resource")
              .eq("objectResourceType", args.resourceType!)
              .eq("objectId", ALL_RESOURCES_OBJECT_ID),
          )
          .collect();
        collect(allResourceGrants);
      }
    }
  }

  return {
    roleIds: effectiveRoleIds,
    entries,
    resourceRoleGrants,
  };

  // Translate raw grant rows into canonical entries. Scope-object role grants
  // only register the effective role for role-permission expansion. A
  // resource-object role grant (a role scoped to a single instance) is captured
  // for downstream role-permission expansion against that instance. Direct
  // permission grants become entries carrying the referenced permission's
  // (resourceType, action), with objectType/objectId preserved so
  // instance-level matching works (authz.entryMatches).
  function collect(
    grants: Array<{
      relationKind: "role" | "direct_permission";
      roleId?: string;
      permissionId?: string;
      effect: "allow" | "deny";
      objectType: "scope" | "resource";
      objectId: string;
      objectResourceType?: string;
      expiresAt?: number;
    }>,
  ) {
    for (const grant of grants) {
      if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) continue;
      if (grant.relationKind === "role") {
        if (typeof grant.roleId !== "string") continue;
        // A scope-object role grant establishes the role membership; its
        // permissions are expanded from role_permissions downstream. Only
        // allow grants register the role (a deny role grant removes the
        // membership it would otherwise add).
        if (grant.objectType === "scope") {
          if (grant.effect === "allow") roleIds.add(grant.roleId);
          continue;
        }
        // A role granted on a resource object (per-instance role scoping, see
        // management.ts grantResourceAccess). The producer emits
        // relationKind="role" + objectType="resource" + roleId here; the role's
        // permission set must be expanded onto the targeted instance. Captured
        // for downstream expansion (needs role-permission + scope context).
        resourceRoleGrants.push({
          roleId: grant.roleId,
          effect: grant.effect,
          objectId: grant.objectId,
          objectResourceType: grant.objectResourceType,
        });
        continue;
      }
      if (typeof grant.permissionId !== "string") continue;
      const permission = args.permissionById.get(grant.permissionId);
      if (!permission) continue;
      // An all-instances resource grant (objectId "*") matches every instance
      // of its resourceType, so it is a TYPE-level entry. Only a concrete
      // objectId stays instance-level. A scope-object grant is always
      // type-level. This preserves the prior `ALL_RESOURCES_OBJECT_ID`
      // collection semantics under the canonical entry model.
      const isInstanceLevel =
        grant.objectType === "resource" && grant.objectId !== ALL_RESOURCES_OBJECT_ID;
      entries.push({
        effect: grant.effect,
        resourceType:
          grant.objectType === "resource" && grant.objectResourceType
            ? grant.objectResourceType
            : permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? grant.objectId : undefined,
        permissionId: grant.permissionId,
      });
    }
  }
}

/**
 * Resolve the union of wildcard modes across the principal's effective roles.
 * immutable (Owner) dominates default (Admin) dominates none, matching "Owner
 * short-circuits, Admin allows-minus-levers" when a user holds multiple roles.
 */
async function resolvePrincipalWildcard(
  ctx: GenericQueryCtx<DataModel>,
  roleIds: string[],
): Promise<WildcardMode> {
  let mode: WildcardMode = "none";
  for (const roleId of roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;
    if (role.wildcard === "immutable") return "immutable";
    if (role.wildcard === "default") mode = "default";
  }
  return mode;
}

async function collectRolePermissionEntries(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    roleIds: string[];
    targetScopeId: string;
    defaultScopeId: string;
    permissionById: PermissionLookup;
  },
): Promise<RuntimeEntry[]> {
  const entries: RuntimeEntry[] = [];

  for (const roleId of args.roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;

    const contribution = await resolveRoleNetPermissionIds(ctx, {
      roleId,
      targetScopeId: args.targetScopeId,
      defaultScopeId: args.defaultScopeId,
    });
    if (!contribution) continue;

    for (const permissionId of contribution.allow) {
      const permission = args.permissionById.get(permissionId);
      if (!permission) continue;
      entries.push({
        effect: "allow",
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: "scope",
        permissionId,
      });
    }

    // An un-narrowed Admin keeps wildcard "default" even with deny rows
    // (deny-only does not narrow Admin per canonical isAdminNarrowed). Emit its
    // net deny set as type-level deny entries so the narrowing deny short-
    // circuits at evaluateAccess step 3 before the Admin default-allow at step
    // 4 — matching the canonical query.ts deny subtraction.
    if (role.wildcard === "default") {
      for (const permissionId of contribution.deny) {
        const permission = args.permissionById.get(permissionId);
        if (!permission) continue;
        entries.push({
          effect: "deny",
          resourceType: permission.resourceType,
          action: permission.action,
          objectType: "scope",
          permissionId,
        });
      }
    }
  }

  return entries;
}

/**
 * Expand role grants scoped to a single resource instance into instance-level
 * entries. An objectId of "*" means all instances of the resourceType, which
 * is a type-level entry. The grant's effect is propagated so a per-instance
 * deny role grant lands as a deny entry (and short-circuits in the
 * deny-override algebra).
 *
 * Wildcard roles (Owner `immutable`, un-narrowed Admin `default`) carry NO
 * enumerated role_permission rows — their power is the wildcard mode, which the
 * canonical evaluator only honors at the principal level. A per-instance grant
 * of such a role would therefore expand to an empty set and silently confer
 * nothing. Instead, emit a single all-actions entry (action "*") on the grant's
 * resourceType, scoped to the instance, so the grant means "full access to this
 * object" — exactly what granting Owner/Admin on a resource implies. The
 * Owner-only-lever fence is moot at the instance level: levers are operations
 * on distinct system resourceTypes (system.app, system.billing, …) and an
 * instance-scoped entry only matches requests carrying this object's id, so it
 * can never reach a lever (levers are scope-level operations, never granted as
 * a single app resource row). Non-wildcard roles fall through to their
 * enumerated net permission set, re-targeted to the instance.
 */
async function collectResourceRoleEntries(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    grants: ResourceRoleGrant[];
    targetScopeId: string;
    defaultScopeId: string;
    permissionById: PermissionLookup;
  },
): Promise<RuntimeEntry[]> {
  const entries: RuntimeEntry[] = [];

  for (const grant of args.grants) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", grant.roleId))
      .unique();
    if (!role) continue;

    const isInstanceLevel = grant.objectId !== ALL_RESOURCES_OBJECT_ID;

    // A resource-object grant without a concrete resourceType is malformed and
    // must confer nothing. Defaulting it to the wildcard would emit an
    // all-resources/all-actions entry, escalating a bare per-instance grant to
    // global all-access.
    if (!grant.objectResourceType) continue;

    // Wildcard role granted on an instance → all-actions allow/deny on that
    // object's resourceType. A wildcard role has no enumerated rows to expand,
    // so without this the grant would be a silent no-op.
    if (role.wildcard === "immutable" || role.wildcard === "default") {
      entries.push({
        effect: grant.effect,
        resourceType: grant.objectResourceType,
        action: WILDCARD_ACTION,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? grant.objectId : undefined,
      });
      continue;
    }

    const contribution = await resolveRoleNetPermissionIds(ctx, {
      roleId: grant.roleId,
      targetScopeId: args.targetScopeId,
      defaultScopeId: args.defaultScopeId,
    });
    if (!contribution) continue;

    for (const permissionId of contribution.allow) {
      const permission = args.permissionById.get(permissionId);
      if (!permission) continue;
      // The grant scopes the role to instances of objectResourceType, so only
      // the role's permissions on that resourceType apply to this object.
      if (permission.resourceType !== grant.objectResourceType) {
        continue;
      }
      entries.push({
        effect: grant.effect,
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? grant.objectId : undefined,
        permissionId,
      });
    }
  }

  return entries;
}

// A role's net permission contribution: the permission ids that end up allowed
// vs denied after applying deny-overrides-allow within the role. Mirrors the
// canonical RolePermissionContribution {allow, deny} model (query.ts).
type RoleContribution = { allow: Set<string>; deny: Set<string> };

/**
 * Resolve a role's net permission contribution: the role's own-scope
 * role_permission rows (allow adds, deny removes), plus — for system roles
 * evaluated in a non-default scope — the target org's override rows layered on
 * top. Returns null when the role row is missing.
 */
async function resolveRoleNetPermissionIds(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleId: string; targetScopeId: string; defaultScopeId: string },
): Promise<RoleContribution | null> {
  const role = await ctx.db
    .query("roles")
    .withIndex("by_role_id", (q) => q.eq("roleId", args.roleId))
    .unique();
  if (!role) return null;

  const contribution: RoleContribution = { allow: new Set(), deny: new Set() };
  await applyRolePermissionRows(ctx, {
    accessScopeId: role.accessScopeId,
    roleId: args.roleId,
    contribution,
  });

  if (role.kind === "system" && args.targetScopeId !== args.defaultScopeId) {
    await applyRolePermissionRows(ctx, {
      accessScopeId: args.targetScopeId,
      roleId: args.roleId,
      contribution,
    });
  }

  return contribution;
}

/**
 * Fold one scope's role_permission rows into a {allow, deny} contribution using
 * canonical semantics: an allow row adds to allow / clears deny, a deny row adds
 * to deny / clears allow.
 */
async function applyRolePermissionRows(
  ctx: GenericQueryCtx<DataModel>,
  args: { accessScopeId: string; roleId: string; contribution: RoleContribution },
) {
  const rows = await ctx.db
    .query("role_permissions")
    .withIndex("by_role", (q) =>
      q.eq("accessScopeId", args.accessScopeId).eq("roleId", args.roleId),
    )
    .collect();
  for (const row of rows) {
    if (row.effect === "allow") {
      args.contribution.allow.add(row.permissionId);
      args.contribution.deny.delete(row.permissionId);
    } else {
      args.contribution.allow.delete(row.permissionId);
      args.contribution.deny.add(row.permissionId);
    }
  }
}

function deny(
  reasonCode: string,
  sourceVersion?: number,
  principalId?: string,
  effectiveRoleIds?: string[],
): EffectiveAccessEvaluation {
  return {
    allowed: false,
    reasonCode,
    sourceVersion,
    principalId,
    effectiveRoleIds: effectiveRoleIds ?? [],
    catalogPermissions: [],
    wildcard: "none",
    entries: [],
  };
}
