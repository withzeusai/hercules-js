import type { DataModelFromSchemaDefinition, GenericQueryCtx } from "convex/server";
import {
  actionMatches,
  isOwnerOnlyLever,
  MANAGE_ACTION,
  WILDCARD_ACTION,
  type ApplicableEntry,
  type WildcardMode,
} from "./authz";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

const DEFAULT_SCOPE_SENTINEL = "__hercules_default_tenant__";
const MAX_AUTHORIZATION_ANCESTORS = 10;

export type AuthorizationAncestor = {
  resourceType: string;
  resourceId: string;
};

export function normalizeAuthorizationAncestors(
  ancestors: AuthorizationAncestor[] | undefined,
): AuthorizationAncestor[] | null {
  if ((ancestors?.length ?? 0) > MAX_AUTHORIZATION_ANCESTORS) {
    return null;
  }
  const normalized: AuthorizationAncestor[] = [];
  const seen = new Set<string>();
  for (const ancestor of ancestors ?? []) {
    if (ancestor.resourceType.length === 0 || ancestor.resourceId.length === 0) {
      return null;
    }
    const key = `${ancestor.resourceType}\0${ancestor.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(ancestor);
  }
  return normalized;
}

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
// catalog permission with its own action. Superset-action (`manage`/`*`)
// catalog keys themselves are control-plane-only and are filtered from the
// enumeration (see isSupersetAction). The evaluator (evaluateAccess) ignores
// this extra field.
export type AccessEntrySource =
  | { kind: "role_permission"; roleId: string }
  | {
      kind: "permission_grant";
      grantId: string;
      subject: AccessGrantSubject;
      inherited: boolean;
    }
  | {
      kind: "resource_role";
      grantId: string;
      roleId: string;
      subject: AccessGrantSubject;
      inherited: boolean;
    };

export type RuntimeEntry = ApplicableEntry & {
  permissionId?: string;
  source?: AccessEntrySource;
};

export type AccessGrantSubject =
  | { type: "user"; id: string }
  | { type: "group"; id: string }
  | { type: "role"; id: string };

export type AccessGrantTarget =
  | { type: "tenant" }
  | { type: "resource"; resourceType: string; resourceId?: string };

export type AccessGrantTrace = {
  grantId: string;
  grantType: "role" | "permission";
  subject: AccessGrantSubject;
  roleId?: string;
  permissionId?: string;
  effect: "allow" | "deny";
  target: AccessGrantTarget;
  appliesTo: "self" | "self_and_descendants";
  expiresAt: number | null;
  inherited: boolean;
};

export type AccessGroupMembershipTrace = {
  groupId: string;
  groupName?: string;
  status?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  active: boolean;
};

export type EffectiveAccessTrace = {
  groupMemberships: AccessGroupMembershipTrace[];
  appliedGrants: AccessGrantTrace[];
  expiredIgnoredGrants: AccessGrantTrace[];
};

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
  trace?: EffectiveAccessTrace;
};

export async function evaluateEffectiveAccess(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    tokenIdentifier?: string;
    scopeId?: string;
    resourceType?: string;
    resourceId?: string;
    ancestors?: AuthorizationAncestor[];
    includeTrace?: boolean;
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
    return deny("tenant_missing", state.sourceVersion);
  }
  if (args.resourceId !== undefined && args.resourceType === undefined) {
    return deny("invalid_request", state.sourceVersion);
  }
  const ancestors = normalizeAuthorizationAncestors(args.ancestors);
  if (ancestors === null) {
    return deny("invalid_request", state.sourceVersion);
  }

  const defaultScope = await ctx.db
    .query("scopes")
    .withIndex("by_kind", (q) => q.eq("kind", "default"))
    .unique();
  if (!defaultScope) {
    return deny("default_tenant_missing", state.sourceVersion);
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
    return deny("tenant_missing", state.sourceVersion);
  }
  if (scope.status === "disabled") {
    return deny("tenant_disabled", state.sourceVersion);
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

  // H2 cross-scope fence (app-level standing): acting in a non-default scope
  // ALSO requires an ACTIVE user principal in the default (app) scope. The
  // control plane enforces this on every app-user mutation
  // (loadActivePrincipalByAuthUser); without the same fence here, a user
  // blocked/suspended/removed at the app level would keep full org-scope
  // access at runtime until each org membership was also revoked. Fail
  // closed: a missing or non-user app-scope principal denies too.
  if (scope.accessScopeId !== defaultScope.accessScopeId) {
    const appPrincipal = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", defaultScope.accessScopeId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!appPrincipal || appPrincipal.type !== "user") {
      return deny("app_principal_missing", state.sourceVersion, principal.principalId);
    }
    if (appPrincipal.status !== "active") {
      return deny(
        `app_principal_${appPrincipal.status}`,
        state.sourceVersion,
        principal.principalId,
      );
    }
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

  const trace: EffectiveAccessTrace | undefined = args.includeTrace
    ? {
        groupMemberships: [],
        appliedGrants: [],
        expiredIgnoredGrants: [],
      }
    : undefined;
  const principalIds = await collectPrincipalIds(ctx, {
    principalId: principal.principalId,
    scopeId: scope.accessScopeId,
    trace,
  });

  const grantContributions = await collectGrantContributions(ctx, {
    principalIds,
    rootPrincipalId: principal.principalId,
    scopeId: scope.accessScopeId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    ancestors,
    permissionById,
    trace,
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
    targetResourceType: args.resourceType,
    targetResourceId: args.resourceId,
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
    ...(trace ? { trace } : {}),
  };
}

/**
 * Grant-side superset action tokens (`manage`, `*`) are never runtime-
 * checkable: can() requests carry concrete verbs only, so the authorize gate
 * (checks.ts evaluatePermissionDecision) rejects a request whose resolved
 * catalog action is a superset token with `invalid_request` — even for an
 * Owner. Shared by that gate and {@link enumeratePermissions} so the two stay
 * consistent by construction.
 */
export function isSupersetAction(action: string): boolean {
  return action === MANAGE_ACTION || action === WILDCARD_ACTION;
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
 *
 * Superset-action catalog keys (`:manage`, `:*`) are control-plane management
 * gates, not runtime-checkable permissions: the authorize gate rejects them
 * with `invalid_request` ({@link isSupersetAction}), so they are excluded here
 * for every wildcard mode — getEffectivePermissions must never advertise a key
 * the runtime will then deny. The capability such a grant confers is still
 * fully reported: a `manage`/`*` allow entry expands onto the concrete-verb
 * catalog keys it covers via actionMatches.
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
      // Control-plane-only keys: never advertised at runtime (see doc above).
      if (isSupersetAction(permission.action)) return false;
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

// Exported so the consumer-plane role-listing query (queries.collectPrincipalScopeRoles)
// shares the SAME E3 blocked-group fence rather than re-expanding memberships
// without checking the group principal is an active, in-scope group.
export async function collectPrincipalIds(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    principalId: string;
    scopeId: string;
    trace?: EffectiveAccessTrace;
  },
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
    // and is active. A blocked/suspended/removed group, a deleted group, or a row
    // that points at a non-group principal must grant nothing. The membership query
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
    args.trace?.groupMemberships.push({
      groupId: membership.groupPrincipalId,
      ...(groupPrincipal?.type === "group" && groupPrincipal.name !== undefined
        ? { groupName: groupPrincipal.name }
        : {}),
      ...(groupPrincipal?.type === "group" ? { status: groupPrincipal.status } : {}),
      active:
        groupPrincipal?.type === "group" &&
        groupPrincipal.accessScopeId === args.scopeId &&
        groupPrincipal.status === "active",
    });
  }
  return [...principalIds];
}

type PermissionLookup = Map<string, { resourceType: string; action: string }>;

// A role granted on a resource target (role_binding with a non-undefined
// resourceType). resourceId undefined => every resource of the type (type-wide);
// set => one exact resource. Effect is always allow for a role binding (the
// producer has no deny role binding), but we carry it for shape parity.
type ResourceRoleGrant = {
  bindingId: string;
  roleId: string;
  effect: "allow" | "deny";
  resourceType: string;
  resourceId?: string;
  inherited: boolean;
  subject: AccessGrantSubject;
};

type BindingTarget = {
  resourceType?: string;
  resourceId?: string;
  inherited: boolean;
};

async function collectGrantContributions(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    principalIds: string[];
    rootPrincipalId: string;
    scopeId: string;
    resourceType?: string;
    resourceId?: string;
    ancestors: AuthorizationAncestor[];
    permissionById: PermissionLookup;
    trace?: EffectiveAccessTrace;
  },
) {
  // sync.ts schedules an exact-identity binding deletion at expiresAt so this
  // query is reactively invalidated. Keep the timestamp check as a fail-closed
  // fallback if the scheduled mutation is delayed.
  const now = Date.now();
  const principalIds = new Set(args.principalIds);
  const scopeRoleIds = new Set<string>();
  const entries: RuntimeEntry[] = [];
  const resourceRoleGrants: ResourceRoleGrant[] = [];
  const seenRoleBindings = new Set<string>();
  const seenPermissionBindings = new Set<string>();
  const targets = dedupeBindingTargets([
    { inherited: false },
    ...(args.resourceType
      ? [
          { resourceType: args.resourceType, inherited: false },
          ...(args.resourceId
            ? [
                {
                  resourceType: args.resourceType,
                  resourceId: args.resourceId,
                  inherited: false,
                },
              ]
            : []),
        ]
      : []),
    ...args.ancestors.map((ancestor) => ({ ...ancestor, inherited: true })),
  ]);
  for (const target of targets) {
    for (const principalId of principalIds) {
      const subject: AccessGrantSubject =
        principalId === args.rootPrincipalId
          ? { type: "user", id: principalId }
          : { type: "group", id: principalId };
      const [roleBindings, permissionBindings] = await Promise.all([
        ctx.db
          .query("role_bindings")
          .withIndex("by_subject_scope_resource", (q) =>
            q
              .eq("subjectPrincipalId", principalId)
              .eq("accessScopeId", args.scopeId)
              .eq("resourceType", target.resourceType)
              .eq("resourceId", target.resourceId),
          )
          .collect(),
        ctx.db
          .query("permission_bindings")
          .withIndex("by_subject_principal_scope_resource", (q) =>
            q
              .eq("subjectPrincipalId", principalId)
              .eq("accessScopeId", args.scopeId)
              .eq("resourceType", target.resourceType)
              .eq("resourceId", target.resourceId),
          )
          .collect(),
      ]);
      collectRoleBindings(roleBindings, target, subject);
      collectDirectPermissionBindings(permissionBindings, target, subject);
    }
  }

  const candidateRoleIds = new Set([
    ...scopeRoleIds,
    ...resourceRoleGrants.map((grant) => grant.roleId),
  ]);
  const validRoleIds = new Set<string>();
  for (const roleId of candidateRoleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (role) validRoleIds.add(roleId);
  }
  const effectiveRoleIds = [...scopeRoleIds].filter((roleId) => validRoleIds.has(roleId));
  const resourceRoleIds = new Set(
    resourceRoleGrants.map((grant) => grant.roleId).filter((roleId) => validRoleIds.has(roleId)),
  );

  // Resource-scoped roles participate in role-subject rules for the bounded
  // resource targets in this evaluation, but stay out of effectiveRoleIds so
  // they cannot acquire scope-wide role permissions or wildcard behavior.
  for (const target of targets) {
    const applicableRoleIds =
      target.resourceType === undefined
        ? new Set(effectiveRoleIds)
        : new Set([...effectiveRoleIds, ...resourceRoleIds]);
    for (const roleId of applicableRoleIds) {
      const bindings = await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_role_scope_resource", (q) =>
          q
            .eq("subjectRoleId", roleId)
            .eq("accessScopeId", args.scopeId)
            .eq("resourceType", target.resourceType)
            .eq("resourceId", target.resourceId),
        )
        .collect();
      collectDirectPermissionBindings(bindings, target, { type: "role", id: roleId });
    }
  }

  return {
    roleIds: effectiveRoleIds,
    entries,
    resourceRoleGrants: resourceRoleGrants.filter((grant) => validRoleIds.has(grant.roleId)),
  };

  // A resource-target role binding scopes the role to instances of
  // resourceType. Captured for downstream role-permission expansion against the
  // target (needs role-permission + scope context). A type-wide binding
  // (resourceId undefined) expands as a type-level entry; a specific binding as
  // an instance-level entry.
  function collectRoleBindings(
    bindings: Array<{
      bindingId: string;
      roleId: string;
      resourceType?: string;
      resourceId?: string;
      appliesTo: "self" | "self_and_descendants";
      expiresAt?: number;
    }>,
    target: BindingTarget,
    subject: AccessGrantSubject,
  ) {
    for (const binding of bindings) {
      if (seenRoleBindings.has(binding.bindingId)) continue;
      seenRoleBindings.add(binding.bindingId);
      const grantTrace = roleGrantTrace(binding, target, subject);
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) {
        args.trace?.expiredIgnoredGrants.push(grantTrace);
        continue;
      }
      if (target.inherited && binding.appliesTo !== "self_and_descendants") continue;
      if (binding.resourceType === undefined) {
        scopeRoleIds.add(binding.roleId);
        args.trace?.appliedGrants.push(grantTrace);
        continue;
      }
      if (!binding.resourceType) continue;
      args.trace?.appliedGrants.push(grantTrace);
      resourceRoleGrants.push({
        bindingId: binding.bindingId,
        roleId: binding.roleId,
        effect: "allow",
        resourceType: binding.resourceType,
        resourceId: binding.resourceId,
        inherited: target.inherited,
        subject,
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
      bindingId: string;
      permissionId: string;
      effect: "allow" | "deny";
      resourceType?: string;
      resourceId?: string;
      appliesTo: "self" | "self_and_descendants";
      expiresAt?: number;
    }>,
    target: BindingTarget,
    subject: AccessGrantSubject,
  ) {
    for (const binding of bindings) {
      if (seenPermissionBindings.has(binding.bindingId)) continue;
      seenPermissionBindings.add(binding.bindingId);
      const grantTrace = permissionGrantTrace(binding, target, subject);
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) {
        args.trace?.expiredIgnoredGrants.push(grantTrace);
        continue;
      }
      if (target.inherited && binding.appliesTo !== "self_and_descendants") continue;
      const permission = args.permissionById.get(binding.permissionId);
      if (!permission) continue;
      // Fail closed: a resource-target binding MUST agree with the permission's
      // resourceType. A binding whose resourceType does not match the
      // permission confers NOTHING — never fall back to the permission's
      // resourceType, which would silently grant the permission onto a
      // foreign/garbage resource type.
      if (
        !target.inherited &&
        binding.resourceType !== undefined &&
        binding.resourceType !== permission.resourceType
      ) {
        continue;
      }
      args.trace?.appliedGrants.push(grantTrace);
      // A concrete resourceId stays instance-level. A scope binding
      // (resourceType undefined) or a type-wide binding (resourceType set,
      // resourceId undefined) is type-level.
      const isInstanceLevel = args.resourceId !== undefined;
      entries.push({
        effect: binding.effect,
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? args.resourceId : undefined,
        permissionId: binding.permissionId,
        source: {
          kind: "permission_grant",
          grantId: binding.bindingId,
          subject,
          inherited: target.inherited,
        },
      });
    }
  }

  function roleGrantTrace(
    binding: {
      bindingId: string;
      roleId: string;
      resourceType?: string;
      resourceId?: string;
      appliesTo: "self" | "self_and_descendants";
      expiresAt?: number;
    },
    target: BindingTarget,
    subject: AccessGrantSubject,
  ): AccessGrantTrace {
    return {
      grantId: binding.bindingId,
      grantType: "role",
      subject,
      roleId: binding.roleId,
      effect: "allow",
      target: grantTarget(binding.resourceType, binding.resourceId),
      appliesTo: binding.appliesTo,
      expiresAt: binding.expiresAt ?? null,
      inherited: target.inherited,
    };
  }

  function permissionGrantTrace(
    binding: {
      bindingId: string;
      permissionId: string;
      effect: "allow" | "deny";
      resourceType?: string;
      resourceId?: string;
      appliesTo: "self" | "self_and_descendants";
      expiresAt?: number;
    },
    target: BindingTarget,
    subject: AccessGrantSubject,
  ): AccessGrantTrace {
    return {
      grantId: binding.bindingId,
      grantType: "permission",
      subject,
      permissionId: binding.permissionId,
      effect: binding.effect,
      target: grantTarget(binding.resourceType, binding.resourceId),
      appliesTo: binding.appliesTo,
      expiresAt: binding.expiresAt ?? null,
      inherited: target.inherited,
    };
  }
}

function grantTarget(resourceType: string | undefined, resourceId: string | undefined) {
  return resourceType === undefined
    ? ({ type: "tenant" } as const)
    : ({
        type: "resource",
        resourceType,
        ...(resourceId === undefined ? {} : { resourceId }),
      } as const);
}

function dedupeBindingTargets(targets: BindingTarget[]): BindingTarget[] {
  const deduped: BindingTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = JSON.stringify([target.resourceType, target.resourceId]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
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
  args: {
    roleIds: string[];
    targetScopeId: string;
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
        source: { kind: "role_permission", roleId },
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
        source: { kind: "role_permission", roleId },
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
  args: {
    grants: ResourceRoleGrant[];
    targetScopeId: string;
    targetResourceType?: string;
    targetResourceId?: string;
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

    const isInstanceLevel = grant.inherited
      ? args.targetResourceId !== undefined
      : grant.resourceId !== undefined;

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
      // role's permissions on that resourceType apply to a flat target. An
      // inherited role is retargeted to the requested child type.
      if (
        (!grant.inherited && permission.resourceType !== grant.resourceType) ||
        (grant.inherited && permission.resourceType !== args.targetResourceType)
      ) {
        continue;
      }
      entries.push({
        effect: grant.effect,
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel
          ? grant.inherited
            ? args.targetResourceId
            : grant.resourceId
          : undefined,
        permissionId,
        source: {
          kind: "resource_role",
          grantId: grant.bindingId,
          roleId: grant.roleId,
          subject: grant.subject,
          inherited: grant.inherited,
        },
      });
    }
    for (const permissionId of contribution.deny) {
      const permission = args.permissionById.get(permissionId);
      if (
        !permission ||
        (!grant.inherited && permission.resourceType !== grant.resourceType) ||
        (grant.inherited && permission.resourceType !== args.targetResourceType)
      ) {
        continue;
      }
      entries.push({
        effect: "deny",
        resourceType: permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel
          ? grant.inherited
            ? args.targetResourceId
            : grant.resourceId
          : undefined,
        permissionId,
        source: {
          kind: "resource_role",
          grantId: grant.bindingId,
          roleId: grant.roleId,
          subject: grant.subject,
          inherited: grant.inherited,
        },
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
export type RoleContribution = {
  allow: Set<string>;
  deny: Set<string>;
  rawAllow: Set<string>;
};

/**
 * Resolve a role's net permission contribution for the target scope: the role's
 * BASE role_permission rows (deployment-wide; allow adds, deny removes), then —
 * layered on top — the target scope's role_permission_overrides (base then
 * override, same layering order as before). Returns null when the role row is
 * missing.
 */
export async function resolveRoleNetPermissionIds(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleId: string; targetScopeId: string },
): Promise<RoleContribution | null> {
  const role = await ctx.db
    .query("roles")
    .withIndex("by_role_id", (q) => q.eq("roleId", args.roleId))
    .unique();
  if (!role) return null;

  const contribution: RoleContribution = {
    allow: new Set(),
    deny: new Set(),
    rawAllow: new Set(),
  };
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
  args: {
    accessScopeId: string;
    roleId: string;
    contribution: RoleContribution;
  },
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
export async function resolveEffectiveWildcard(
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
): EffectiveAccessEvaluation {
  return {
    allowed: false,
    reasonCode,
    sourceVersion,
    principalId,
    effectiveRoleIds: [],
    catalogPermissions: [],
    wildcard: "none",
    entries: [],
  };
}
