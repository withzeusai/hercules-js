import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { evaluatePermissionDecision } from "./checks";
import { enumeratePermissions, evaluateEffectiveAccess } from "./effective";
import schema from "./schema";

const DEFAULT_SCOPE_SENTINEL = "__hercules_default_scope__";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

type Membership = {
  scopeId: string;
  scopeName: string;
  kind: "default" | "org" | "suite";
  roles: RoleSummary[];
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval";
};

type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  scopeId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  // §0b: under the wildcard model `permissions` is a projection over the
  // unbounded catalog (Owner = whole catalog, Admin = catalog minus levers),
  // so it can drift the instant a new permission is created. `wildcard`
  // surfaces the principal's resolved mode so callers can tell an enumerated
  // list ("none") apart from a future-inclusive one ("immutable"/"default")
  // and avoid treating the materialized list as exhaustive.
  wildcard: "none" | "immutable" | "default";
  permissions: string[];
};

type ScopeMember = {
  principalId: string;
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
};

type ScopeRoleSummary = RoleSummary & {
  // True when the role is an app-wide shared role (default scope) surfaced as
  // assignable inside an org scope, rather than a role owned by this scope.
  shared: boolean;
};

type ScopePermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  tenantAssignable: boolean;
};

export const listMyMemberships = query({
  args: { tokenIdentifier: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.tokenIdentifier) return [];

    const state = await ctx.db.query("sync_state").unique();
    if (!state) return [];

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return [];

    const principals = await ctx.db
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("herculesAuthUserId", token.subject))
      .collect();

    const memberships: Membership[] = [];

    for (const principal of principals) {
      const scope = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", principal.accessScopeId))
        .unique();
      if (!scope) continue;
      if (scope.status === "disabled") continue;

      const roles = await collectPrincipalScopeRoles(ctx, {
        principalId: principal.principalId,
        scopeId: principal.accessScopeId,
      });
      if (roles.length === 0) continue;

      memberships.push({
        scopeId: scope.accessScopeId,
        scopeName: scope.name,
        kind: scope.kind,
        roles,
        joinedAt: principal.joinedAt,
        status: principal.status,
      });
    }

    return memberships;
  },
});

export const listMyRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), scopeId: v.string() },
  handler: async (ctx, args): Promise<RoleSummary[]> => {
    if (!args.tokenIdentifier) return [];

    const state = await ctx.db.query("sync_state").unique();
    if (!state) return [];

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return [];

    const scope = await ctx.db
      .query("scopes")
      .withIndex("by_scope_id", (q) => q.eq("accessScopeId", args.scopeId))
      .unique();
    if (!scope || scope.status === "disabled") return [];

    const principal = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", args.scopeId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!principal) return [];

    return collectPrincipalScopeRoles(ctx, {
      principalId: principal.principalId,
      scopeId: args.scopeId,
    });
  },
});

export const getEffectivePermissions = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EffectivePermissionsResult> => {
    const evaluation = await evaluateEffectiveAccess(ctx, args);
    const permissions = enumeratePermissions(
      evaluation.catalogPermissions,
      evaluation.wildcard,
      evaluation.entries,
      args,
    );
    return {
      allowed: evaluation.allowed,
      reasonCode: evaluation.reasonCode,
      sourceVersion: evaluation.sourceVersion,
      scopeId: evaluation.scopeId,
      principalId: evaluation.principalId,
      effectiveRoleIds: evaluation.effectiveRoleIds,
      wildcard: evaluation.wildcard,
      permissions: permissions.map((permission) => permission.key),
    };
  },
});

export const listScopeMembers = query({
  args: { tokenIdentifier: v.optional(v.string()), scopeId: v.string() },
  handler: async (ctx, args): Promise<ScopeMember[]> => {
    if (!(await callerHasScopePermission(ctx, args, "system.members:read"))) return [];
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return [];

    const principals = await ctx.db
      .query("principals")
      .withIndex("by_scope_type", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("type", "user"),
      )
      .collect();

    const members: ScopeMember[] = [];
    for (const principal of principals) {
      let name: string | undefined;
      let email: string | undefined;
      let image: string | undefined;
      const authUserId = principal.herculesAuthUserId;
      if (authUserId) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", authUserId))
          .unique();
        if (user) {
          name = user.name;
          email = user.email;
          image = user.image;
        }
      }
      const roles = await collectPrincipalScopeRoles(ctx, {
        principalId: principal.principalId,
        scopeId: scope.accessScopeId,
      });
      members.push({
        principalId: principal.principalId,
        herculesAuthUserId: authUserId,
        status: principal.status,
        joinedAt: principal.joinedAt,
        name,
        email,
        image,
        roles,
      });
    }

    members.sort((a, b) =>
      (a.name ?? a.email ?? a.principalId).localeCompare(b.name ?? b.email ?? b.principalId),
    );
    return members;
  },
});

export const listScopeRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), scopeId: v.string() },
  handler: async (ctx, args): Promise<ScopeRoleSummary[]> => {
    if (!(await callerHasScopePermission(ctx, args, "system.roles:read"))) return [];
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return [];

    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    const defaultScopeId = defaultScope?.accessScopeId;

    const scopeRoles = await ctx.db
      .query("roles")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", scope.accessScopeId))
      .collect();
    // Shared/app-wide roles (default scope) are assignable inside any org scope,
    // so surface them alongside the scope's own roles when viewing an org.
    const sharedRoles =
      defaultScopeId && defaultScopeId !== scope.accessScopeId
        ? await ctx.db
            .query("roles")
            .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScopeId))
            .collect()
        : [];

    const seen = new Set<string>();
    const roles: ScopeRoleSummary[] = [];
    for (const role of [...scopeRoles, ...sharedRoles]) {
      if (seen.has(role.roleId)) continue;
      seen.add(role.roleId);
      roles.push({
        roleId: role.roleId,
        roleKey: role.key,
        roleName: role.name,
        roleKind: role.kind,
        shared:
          defaultScopeId !== undefined &&
          role.accessScopeId === defaultScopeId &&
          defaultScopeId !== scope.accessScopeId,
      });
    }

    roles.sort(
      (a, b) =>
        a.roleKey.localeCompare(b.roleKey) ||
        a.roleName.localeCompare(b.roleName) ||
        a.roleId.localeCompare(b.roleId),
    );
    return roles;
  },
});

export const listScopePermissions = query({
  args: { tokenIdentifier: v.optional(v.string()), scopeId: v.string() },
  handler: async (ctx, args): Promise<ScopePermissionSummary[]> => {
    if (!(await callerHasScopePermission(ctx, args, "system.permissions:read"))) return [];
    // The permission catalog is app-wide and always lives in the default scope (DL15).
    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    if (!defaultScope) return [];

    const permissions = await ctx.db
      .query("permissions")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScope.accessScopeId))
      .collect();

    return permissions
      .map((permission) => ({
        permissionId: permission.permissionId,
        key: permission.key,
        resourceType: permission.resourceType,
        action: permission.action,
        tenantAssignable: permission.tenantAssignable,
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));
  },
});

type DirectResourceSubject = {
  principalId: string;
  herculesAuthUserId?: string;
  name?: string;
  email?: string;
  image?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval";
  effect: "allow" | "deny";
  expiresAt?: number;
  roleId?: string;
  roleKey?: string;
  roleName?: string;
  permissionId?: string;
  permissionKey?: string;
};

// "Who has a DIRECT grant on this resource" — for an in-app membership panel
// (e.g. "people on this project"). DIRECT grants only: this intentionally does
// NOT include principals who reach the resource via a scope-wide role/wildcard
// or a parent resource. Self-gates resource-aware on `permission` against THIS
// resource (so a per-resource manager, not only a scope admin, can see it), via
// the same evaluator as a real can() check; returns [] when the caller is not
// allowed. `permission`'s resourceType should match `resourceType`.
export const listDirectSubjectsForResource = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    permission: v.string(),
  },
  handler: async (ctx, args): Promise<DirectResourceSubject[]> => {
    const decision = await evaluatePermissionDecision(ctx, {
      tokenIdentifier: args.tokenIdentifier,
      scopeId: args.scopeId,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
    });
    if (!decision.allowed) return [];
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return [];

    const grants = await ctx.db
      .query("grants")
      .withIndex("by_object_resource", (q) =>
        q
          .eq("objectScopeId", scope.accessScopeId)
          .eq("objectType", "resource")
          .eq("objectResourceType", args.resourceType)
          .eq("objectId", args.resourceId),
      )
      .collect();

    const now = Date.now();
    const results: DirectResourceSubject[] = [];
    for (const grant of grants) {
      const subjectPrincipalId = grant.subjectPrincipalId;
      if (!subjectPrincipalId) continue;
      if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) continue;

      const principal = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", subjectPrincipalId))
        .unique();
      if (!principal || principal.type !== "user") continue;

      let name: string | undefined;
      let email: string | undefined;
      let image: string | undefined;
      const authUserId = principal.herculesAuthUserId;
      if (authUserId) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", authUserId))
          .unique();
        if (user) {
          name = user.name;
          email = user.email;
          image = user.image;
        }
      }

      let roleKey: string | undefined;
      let roleName: string | undefined;
      let permissionKey: string | undefined;
      if (grant.relationKind === "role" && grant.roleId) {
        const role = await ctx.db
          .query("roles")
          .withIndex("by_role_id", (q) => q.eq("roleId", grant.roleId!))
          .unique();
        if (role) {
          roleKey = role.key;
          roleName = role.name;
        }
      } else if (grant.relationKind === "direct_permission" && grant.permissionId) {
        const permission = await ctx.db
          .query("permissions")
          .withIndex("by_permission_id", (q) => q.eq("permissionId", grant.permissionId!))
          .unique();
        if (permission) permissionKey = permission.key;
      }

      results.push({
        principalId: principal.principalId,
        herculesAuthUserId: authUserId,
        name,
        email,
        image,
        status: principal.status,
        effect: grant.effect,
        expiresAt: grant.expiresAt,
        roleId: grant.roleId,
        roleKey,
        roleName,
        permissionId: grant.permissionId,
        permissionKey,
      });
    }

    results.sort((a, b) =>
      (a.name ?? a.email ?? a.principalId).localeCompare(b.name ?? b.email ?? b.principalId),
    );
    return results;
  },
});

// Scope-admin reads share the canonical permission gate with authorize(), so an
// in-app admin screen and a can() check resolve identically (wildcard,
// deny-override, owner-only levers). Returns false when not allowed, and the
// queries above then return an empty list.
async function callerHasScopePermission(
  ctx: GenericQueryCtx<DataModel>,
  args: { tokenIdentifier?: string; scopeId: string },
  permission: string,
): Promise<boolean> {
  const decision = await evaluatePermissionDecision(ctx, {
    tokenIdentifier: args.tokenIdentifier,
    scopeId: args.scopeId,
    permission,
  });
  return decision.allowed;
}

async function resolveScopeRow(ctx: GenericQueryCtx<DataModel>, scopeId: string) {
  if (scopeId === DEFAULT_SCOPE_SENTINEL) {
    return await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
  }
  return await ctx.db
    .query("scopes")
    .withIndex("by_scope_id", (q) => q.eq("accessScopeId", scopeId))
    .unique();
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

async function collectPrincipalScopeRoles(
  ctx: GenericQueryCtx<DataModel>,
  args: { principalId: string; scopeId: string },
): Promise<RoleSummary[]> {
  const grants = await ctx.db
    .query("grants")
    .withIndex("by_subject_principal_object", (q) =>
      q
        .eq("subjectPrincipalId", args.principalId)
        .eq("objectType", "scope")
        .eq("objectId", args.scopeId),
    )
    .collect();

  const now = Date.now();
  const roleIds = new Set<string>();
  for (const grant of grants) {
    if (grant.relationKind !== "role") continue;
    if (typeof grant.roleId !== "string") continue;
    if (grant.effect !== "allow") continue;
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) continue;
    roleIds.add(grant.roleId);
  }

  const roles: RoleSummary[] = [];
  for (const roleId of roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;
    roles.push({
      roleId: role.roleId,
      roleKey: role.key,
      roleName: role.name,
      roleKind: role.kind,
    });
  }

  roles.sort(
    (a, b) =>
      a.roleKey.localeCompare(b.roleKey) ||
      a.roleName.localeCompare(b.roleName) ||
      a.roleId.localeCompare(b.roleId),
  );
  return roles;
}
