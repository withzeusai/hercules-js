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

type PermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
};

type CatalogPermission = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
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
  args: { tokenIdentifier?: string; scopeId?: string; resourceType?: string; resourceId?: string },
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
  // E1 (impersonation fence, defense in depth): the caller is authorized AS a
  // user. The by_scope_auth_user lookup is keyed only on (scope,
  // herculesAuthUserId); a group principal that smuggled a victim's
  // herculesAuthUserId would resolve here. The parse fence rejects that payload,
  // but require type==="user" at the resolution point too so a group principal
  // is never authorized as a user.
  if (principal.type !== "user") {
    return deny("principal_missing", state.sourceVersion);
  }
  if (principal.status !== "active") {
    return deny(`principal_${principal.status}`, state.sourceVersion, principal.principalId);
  }

  // The permission catalog is deployment-wide; rows are pinned to the default
  // scope id (schema note on `permissions`), so this default-scope read returns
  // the whole catalog.
  const catalogPermissions = await ctx.db
    .query("permissions")
    .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScope.accessScopeId))
    .collect();
  // permissionId -> (resourceType, action) lookup for translating role and
  // direct-permission bindings (which reference a permissionId) into canonical
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
  const wildcard = await resolvePrincipalWildcard(ctx, {
    roleIds: grantContributions.roleIds,
    targetScopeId: scope.accessScopeId,
  });

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
    permissionById,
  });

  // A role bound to a single resource (a role_binding carrying resourceType)
  // grants that role's permission set, but scoped to the resource. Expand each
  // such binding's role contribution into instance/type-level entries
  // (mirroring collectRolePermissionEntries, then re-targeting from scope-level
  // to the resource target).
  const resourceRoleEntries = await collectResourceRoleEntries(ctx, {
    grants: grantContributions.resourceRoleGrants,
    targetScopeId: scope.accessScopeId,
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
      classification: permission.classification,
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
 *   - else / additionally → there is a matching allow entry whose action
 *     covers the catalog permission, and no matching deny entry overrides it.
 */
export function enumeratePermissions(
  catalogPermissions: CatalogPermission[],
  wildcard: WildcardMode,
  entries: RuntimeEntry[],
  args: { resourceId?: string },
): PermissionSummary[] {
  const entryMatchesPermission = (entry: RuntimeEntry, permission: CatalogPermission): boolean => {
    if (entry.objectType === "resource" && entry.objectId !== args.resourceId) {
      return false;
    }
    return (
      (entry.resourceType === WILDCARD_ACTION || entry.resourceType === permission.resourceType) &&
      actionMatches(entry.action, permission.action)
    );
  };

  const isDenied = (permission: CatalogPermission): boolean =>
    entries.some((entry) => entry.effect === "deny" && entryMatchesPermission(entry, permission));

  const isAllowed = (permission: CatalogPermission): boolean =>
    entries.some((entry) => entry.effect === "allow" && entryMatchesPermission(entry, permission));

  return catalogPermissions
    .filter((permission) => {
      if (wildcard === "immutable") return true;
      if (isDenied(permission)) return false;
      const ownerOnly = isOwnerOnlyLever({
        resourceType: permission.resourceType,
        action: permission.action,
        classification: permission.classification,
      });
      if (wildcard === "default" && !ownerOnly) {
        return true;
      }
      if (ownerOnly) return false;
      return isAllowed(permission);
    })
    .map((permission) => ({
      permissionId: permission.permissionId,
      key: permission.key,
      resourceType: permission.resourceType,
      action: permission.action,
      classification: permission.classification,
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
    // E3 (blocked group fence): a membership only confers the group's authority
    // when the group principal actually exists, is a group, lives in this scope,
    // and is active. A blocked/suspended group, a deleted group, or a row that
    // points at a non-group principal must grant nothing. The membership query
    // is already scope-pinned, so a same-id group resolution confirms scope.
    const groupPrincipal = await ctx.db
      .query("principals")
      .withIndex("by_principal_id", (q) => q.eq("principalId", membership.groupPrincipalId))
      .unique();
    if (
      groupPrincipal &&
      groupPrincipal.type === "group" &&
      groupPrincipal.accessScopeId === args.scopeId &&
      groupPrincipal.status === "active"
    ) {
      principalIds.add(membership.groupPrincipalId);
    }
  }
  return [...principalIds];
}

type PermissionLookup = Map<string, { resourceType: string; action: string }>;

// A role granted on a resource target (role_binding with a non-undefined
// resourceType). resourceId undefined => every resource of the type (type-wide);
// set => one exact resource. Effect is always allow for a role binding (the
// producer has no deny role binding), but we carry it for shape parity.
type ResourceRoleGrant = {
  roleId: string;
  effect: "allow" | "deny";
  resourceType: string;
  resourceId?: string;
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
  // sync.ts schedules an exact-identity binding deletion at expiresAt so this
  // query is reactively invalidated. Keep the timestamp check as a fail-closed
  // fallback if the scheduled mutation is delayed.
  const now = Date.now();
  const roleIds = new Set<string>();
  const deniedRoleIds = new Set<string>();
  const entries: RuntimeEntry[] = [];
  const resourceRoleGrants: ResourceRoleGrant[] = [];

  for (const principalId of args.principalIds) {
    // Scope-object role bindings (resourceType undefined): establish role
    // membership. The role's permissions are expanded downstream.
    const scopeRoleBindings = await ctx.db
      .query("role_bindings")
      .withIndex("by_subject_scope_resource", (q) =>
        q
          .eq("subjectPrincipalId", principalId)
          .eq("accessScopeId", args.scopeId)
          .eq("resourceType", undefined)
          .eq("resourceId", undefined),
      )
      .collect();
    for (const binding of scopeRoleBindings) {
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) continue;
      // A role binding always registers the role; there is no deny role binding
      // on the wire, so membership is purely additive.
      if (!deniedRoleIds.has(binding.roleId)) {
        roleIds.add(binding.roleId);
      }
    }

    // Scope-object direct-permission bindings (resourceType undefined).
    const scopePermissionBindings = await ctx.db
      .query("permission_bindings")
      .withIndex("by_subject_principal_scope_resource", (q) =>
        q
          .eq("subjectPrincipalId", principalId)
          .eq("accessScopeId", args.scopeId)
          .eq("resourceType", undefined)
          .eq("resourceId", undefined),
      )
      .collect();
    collectDirectPermissionBindings(scopePermissionBindings);

    if (args.resourceType && args.resourceId) {
      // Specific-resource role bindings: a role scoped to this exact resource.
      const specificRoleBindings = await ctx.db
        .query("role_bindings")
        .withIndex("by_subject_scope_resource", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", args.resourceId),
        )
        .collect();
      collectResourceRoleBindings(specificRoleBindings);

      // Type-wide role bindings (resourceId undefined): the role applies to
      // every resource of the type, so it also covers this specific resource.
      const typeWideRoleBindings = await ctx.db
        .query("role_bindings")
        .withIndex("by_subject_scope_resource", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", undefined),
        )
        .collect();
      collectResourceRoleBindings(typeWideRoleBindings);

      // Specific-resource direct-permission bindings.
      const specificPermissionBindings = await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_principal_scope_resource", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", args.resourceId),
        )
        .collect();
      collectDirectPermissionBindings(specificPermissionBindings);

      // Type-wide direct-permission bindings (resourceId undefined).
      const typeWidePermissionBindings = await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_principal_scope_resource", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", undefined),
        )
        .collect();
      collectDirectPermissionBindings(typeWidePermissionBindings);
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

  // Role-subject permission bindings: a direct-permission rule that applies to
  // every holder of a role on this resource (subjectRoleId set). The old
  // role-subject grants were modeled only as direct-permission bindings; a role
  // subject with a role relation does NOT exist on the wire.
  if (args.resourceType && args.resourceId) {
    for (const roleId of effectiveRoleIds) {
      const specificRoleSubjectBindings = await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_role_scope_resource", (q) =>
          q
            .eq("subjectRoleId", roleId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", args.resourceId),
        )
        .collect();
      collectDirectPermissionBindings(specificRoleSubjectBindings);

      const typeWideRoleSubjectBindings = await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_role_scope_resource", (q) =>
          q
            .eq("subjectRoleId", roleId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", undefined),
        )
        .collect();
      collectDirectPermissionBindings(typeWideRoleSubjectBindings);
    }
  }

  return { roleIds: effectiveRoleIds, entries, resourceRoleGrants };

  // A resource-target role binding scopes the role to instances of
  // resourceType. Captured for downstream role-permission expansion against the
  // target (needs role-permission + scope context). A type-wide binding
  // (resourceId undefined) expands as a type-level entry; a specific binding as
  // an instance-level entry.
  function collectResourceRoleBindings(
    bindings: Array<{
      roleId: string;
      resourceType?: string;
      resourceId?: string;
      expiresAt?: number;
    }>,
  ) {
    for (const binding of bindings) {
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) continue;
      if (!binding.resourceType) continue;
      resourceRoleGrants.push({
        roleId: binding.roleId,
        effect: "allow",
        resourceType: binding.resourceType,
        resourceId: binding.resourceId,
      });
    }
  }

  // Direct-permission bindings become entries carrying the referenced
  // permission's (resourceType, action), with the resource target preserved so
  // instance-level matching works (authz.entryMatches). A binding with a
  // resourceType but no resourceId is type-wide => a scope/type-level entry; a
  // binding with a concrete resourceId is instance-level.
  function collectDirectPermissionBindings(
    bindings: Array<{
      permissionId: string;
      effect: "allow" | "deny";
      resourceType?: string;
      resourceId?: string;
      expiresAt?: number;
    }>,
  ) {
    for (const binding of bindings) {
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) continue;
      const permission = args.permissionById.get(binding.permissionId);
      if (!permission) continue;
      // Fail closed: a resource-target binding MUST agree with the permission's
      // resourceType. A binding whose resourceType does not match the
      // permission confers NOTHING — never fall back to the permission's
      // resourceType, which would silently grant the permission onto a
      // foreign/garbage resource type.
      if (binding.resourceType !== undefined && binding.resourceType !== permission.resourceType) {
        continue;
      }
      // A concrete resourceId stays instance-level. A scope binding
      // (resourceType undefined) or a type-wide binding (resourceType set,
      // resourceId undefined) is type-level.
      const isInstanceLevel = binding.resourceId !== undefined;
      entries.push({
        effect: binding.effect,
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? binding.resourceId : undefined,
        permissionId: binding.permissionId,
      });
    }
  }
}

/**
 * Resolve the union of EFFECTIVE wildcard modes across the principal's effective
 * roles. immutable (Owner) dominates default (Admin) dominates none, matching
 * "Owner short-circuits, Admin allows-minus-levers" when a user holds multiple
 * roles.
 *
 * The wire never carries a pre-computed effective wildcard (the deployment-wide
 * catalog role is shared across scopes). It carries only the INTRINSIC
 * `baseWildcard`. The effective wildcard is derived PER SCOPE here: a
 * `default`-wildcard role (Admin) stays `default` when un-narrowed in this
 * scope, but downgrades to `none` when narrowed. Narrowed = the presence of an
 * ALLOW row in the role's base role-permissions UNION that scope's overrides (a
 * deny-only override does NOT un-narrow, because narrowing keys on the presence
 * of an allow row, not the net set). This is the prior narrowed-Admin downgrade
 * (rawAllow.size === 0 stays default; any allow row downgrades to none).
 */
async function resolvePrincipalWildcard(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleIds: string[]; targetScopeId: string },
): Promise<WildcardMode> {
  let mode: WildcardMode = "none";
  for (const roleId of args.roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;
    if (role.baseWildcard === "immutable") return "immutable";
    if (role.baseWildcard === "default") {
      const contribution = await resolveRoleNetPermissionIds(ctx, {
        roleId,
        targetScopeId: args.targetScopeId,
      });
      if (!contribution || contribution.rawAllow.size === 0) {
        mode = "default";
      }
    }
  }
  return mode;
}

async function collectRolePermissionEntries(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleIds: string[]; targetScopeId: string; permissionById: PermissionLookup },
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

    // Explicit deny wins across all role contributions. This mirrors the
    // control-plane evaluator, where a deny from one role subtracts an allow
    // from another role or a direct grant.
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

  return entries;
}

/**
 * Expand role bindings scoped to a resource target into entries. A type-wide
 * binding (resourceId undefined) is a type-level entry; a specific binding is an
 * instance-level entry. The binding's effect is propagated so a per-resource
 * deny lands as a deny entry (and short-circuits in the deny-override algebra).
 *
 * Only non-system, non-wildcard roles can be bound to resources. The control
 * plane (classifyResourceGrantOp + resource-effective.ts) rejects ONLY
 * system-source roles on a resource and expands every other non-archived role
 * onto it, so an iam-source role grant is legally accepted, stored, mirrored,
 * shown, and honored there. The runtime must match: skip only `source ===
 * "system"` (Owner/Admin scope memberships) so iam and tenant roles both
 * expand. The wildcard check below still drops any role whose effective
 * wildcard is non-`none`.
 */
async function collectResourceRoleEntries(
  ctx: GenericQueryCtx<DataModel>,
  args: { grants: ResourceRoleGrant[]; targetScopeId: string; permissionById: PermissionLookup },
): Promise<RuntimeEntry[]> {
  const entries: RuntimeEntry[] = [];

  for (const grant of args.grants) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", grant.roleId))
      .unique();
    if (!role) continue;

    const isInstanceLevel = grant.resourceId !== undefined;

    // A resource-target binding without a concrete resourceType is malformed and
    // must confer nothing. Defaulting it to the wildcard would emit an
    // all-resources/all-actions entry, escalating a bare per-resource binding to
    // global all-access.
    if (!grant.resourceType) continue;

    // Only non-system, non-wildcard roles expand onto resources. A system role
    // (Owner/Admin) is a scope membership that the control plane forbids on a
    // resource, so it is skipped here too. An iam-source role IS a legal
    // resource grant on the control plane, so it must expand at runtime to keep
    // parity. The effective wildcard is derived per scope; an iam role's base
    // wildcard is "none", so it survives, while any wildcard role is excluded.
    const effectiveWildcard = await resolveEffectiveWildcard(ctx, {
      role,
      targetScopeId: args.targetScopeId,
    });
    if (role.source === "system" || effectiveWildcard !== "none") continue;

    const contribution = await resolveRoleNetPermissionIds(ctx, {
      roleId: grant.roleId,
      targetScopeId: args.targetScopeId,
    });
    if (!contribution) continue;

    for (const permissionId of contribution.allow) {
      const permission = args.permissionById.get(permissionId);
      if (!permission) continue;
      // The binding scopes the role to instances of resourceType, so only the
      // role's permissions on that resourceType apply to this target.
      if (permission.resourceType !== grant.resourceType) {
        continue;
      }
      entries.push({
        effect: grant.effect,
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? grant.resourceId : undefined,
        permissionId,
      });
    }
    for (const permissionId of contribution.deny) {
      const permission = args.permissionById.get(permissionId);
      if (!permission || permission.resourceType !== grant.resourceType) {
        continue;
      }
      entries.push({
        effect: "deny",
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? grant.resourceId : undefined,
        permissionId,
      });
    }
  }

  return entries;
}

// A role's net permission contribution: the permission ids that end up allowed
// vs denied after applying deny-overrides-allow within the role. Mirrors the
// canonical RolePermissionContribution {allow, deny} model (query.ts). rawAllow
// records every allow row seen (base + override) regardless of later deny, so
// the narrowed-Admin downgrade can key on the PRESENCE of an allow row.
type RoleContribution = { allow: Set<string>; deny: Set<string>; rawAllow: Set<string> };

/**
 * Resolve a role's net permission contribution for the target scope: the role's
 * BASE role_permission rows (deployment-wide; allow adds, deny removes), then —
 * layered on top — the target scope's role_permission_overrides (base then
 * override, same layering order as before). Returns null when the role row is
 * missing.
 */
async function resolveRoleNetPermissionIds(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleId: string; targetScopeId: string },
): Promise<RoleContribution | null> {
  const role = await ctx.db
    .query("roles")
    .withIndex("by_role_id", (q) => q.eq("roleId", args.roleId))
    .unique();
  if (!role) return null;

  const contribution: RoleContribution = { allow: new Set(), deny: new Set(), rawAllow: new Set() };
  // Base map (deployment-wide).
  await applyBaseRolePermissionRows(ctx, { roleId: args.roleId, contribution });
  // Per-scope override, layered on top of the base (preserves per-scope
  // overrides; deny wins within each layer, base folded before override).
  await applyRolePermissionOverrideRows(ctx, {
    accessScopeId: args.targetScopeId,
    roleId: args.roleId,
    contribution,
  });

  return contribution;
}

/**
 * Fold the deployment-wide BASE role_permission rows into a {allow, deny}
 * contribution: an allow row adds to allow / clears deny, a deny row adds to
 * deny / clears allow. rawAllow accumulates every allow row regardless of a
 * later deny.
 */
async function applyBaseRolePermissionRows(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleId: string; contribution: RoleContribution },
) {
  const rows = await ctx.db
    .query("role_permissions")
    .withIndex("by_role", (q) => q.eq("roleId", args.roleId))
    .collect();
  applyRolePermissionRows(rows, args.contribution);
}

/**
 * Fold one scope's role_permission_override rows into the contribution on top of
 * the base map (same allow-adds / deny-removes semantics).
 */
async function applyRolePermissionOverrideRows(
  ctx: GenericQueryCtx<DataModel>,
  args: { accessScopeId: string; roleId: string; contribution: RoleContribution },
) {
  const rows = await ctx.db
    .query("role_permission_overrides")
    .withIndex("by_scope_role", (q) =>
      q.eq("accessScopeId", args.accessScopeId).eq("roleId", args.roleId),
    )
    .collect();
  applyRolePermissionRows(rows, args.contribution);
}

/**
 * Apply one layer's effect rows into a {allow, deny, rawAllow} contribution
 * using canonical semantics: within the layer, deny wins regardless of row
 * order, so apply the allow rows first and then let the deny rows override.
 * rawAllow records every allow row's permissionId (never cleared) so the
 * narrowed-Admin downgrade keys on the PRESENCE of an allow row, not the net set
 * — a deny-only override therefore never un-narrows.
 */
function applyRolePermissionRows(
  rows: Array<{ permissionId: string; effect: "allow" | "deny" }>,
  contribution: RoleContribution,
) {
  for (const row of rows) {
    if (row.effect === "allow") {
      contribution.rawAllow.add(row.permissionId);
      contribution.allow.add(row.permissionId);
      contribution.deny.delete(row.permissionId);
    }
  }
  for (const row of rows) {
    if (row.effect === "deny") {
      contribution.allow.delete(row.permissionId);
      contribution.deny.add(row.permissionId);
    }
  }
}

/**
 * Derive a single role's EFFECTIVE wildcard for the target scope from its
 * intrinsic baseWildcard plus per-scope narrowing — the same derivation
 * resolvePrincipalWildcard applies, exposed for the resource-role gate. Owner
 * (immutable) stays immutable; a default (Admin) role stays default when
 * un-narrowed and downgrades to none when narrowed (any allow row present in
 * base UNION overrides); everything else is none.
 */
async function resolveEffectiveWildcard(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    role: { roleId: string; baseWildcard: "none" | "immutable" | "default" };
    targetScopeId: string;
  },
): Promise<WildcardMode> {
  if (args.role.baseWildcard === "immutable") return "immutable";
  if (args.role.baseWildcard === "default") {
    const contribution = await resolveRoleNetPermissionIds(ctx, {
      roleId: args.role.roleId,
      targetScopeId: args.targetScopeId,
    });
    if (!contribution || contribution.rawAllow.size === 0) {
      return "default";
    }
    return "none";
  }
  return "none";
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
