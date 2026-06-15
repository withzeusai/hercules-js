import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { evaluatePermissionDecision } from "./checks";
import {
  collectPrincipalIds,
  enumeratePermissions,
  evaluateEffectiveAccess,
} from "./effective";
import schema from "./schema";

const DEFAULT_SCOPE_SENTINEL = "__hercules_default_scope__";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// Public within the component boundary (parent-facing API; see checks.ts).
const query = queryGeneric as QueryBuilder<DataModel, "public">;

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

// The external RoleSummary surface still reports `roleKind: "system" | "custom"`
// (client/index.ts + the generated component shape). v3 roles carry `source`
// (system | iam | tenant) instead of the old `kind`. A tenant (org-authored)
// role is "custom"; reusable catalog roles (system or iam) are "system".
function roleKindFromSource(source: "system" | "iam" | "tenant"): "system" | "custom" {
  return source === "tenant" ? "custom" : "system";
}

type Membership = {
  scopeId: string;
  scopeName: string;
  kind: "default" | "org" | "suite";
  roles: RoleSummary[];
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
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

type ScopeMemberDirectoryEntry = {
  principalId: string;
  herculesAuthUserId: string;
  name: string;
  email: string;
  image?: string;
  roleKeys: string[];
};

type ScopeMember = {
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  // A user member's name/email/image come from the deployment-wide user row; a
  // group member's name is the group's own display name (groups have no
  // email/image).
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
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

export const getDeploymentEntryStatus = query({
  args: { tokenIdentifier: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.tokenIdentifier) {
      return { kind: "fallback" as const, reason: "identity_missing" as const };
    }

    const state = await ctx.db.query("sync_state").unique();
    if (!state) {
      return { kind: "fallback" as const, reason: "mirror_not_ready" as const };
    }

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token) {
      return {
        kind: "fallback" as const,
        reason: "identity_invalid" as const,
        stateVersion: state.sourceVersion,
      };
    }
    if (token.issuer !== state.expectedIssuer) {
      return {
        kind: "fallback" as const,
        reason: "unexpected_issuer" as const,
        stateVersion: state.sourceVersion,
      };
    }

    const scope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    if (!scope || scope.status !== "active") {
      return {
        kind: "fallback" as const,
        reason: "default_scope_missing" as const,
        stateVersion: state.sourceVersion,
      };
    }

    const principal = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!principal || principal.type !== "user") {
      return {
        kind: "fallback" as const,
        reason: "principal_missing" as const,
        stateVersion: state.sourceVersion,
      };
    }

    return {
      kind: "principal" as const,
      principalId: principal.principalId,
      status: principal.status,
      stateVersion: state.sourceVersion,
    };
  },
});

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

    // E5: resolve the scope through resolveScopeRow so the
    // __hercules_default_scope__ sentinel maps to the real default scope (the
    // other queries already do this; using the sentinel literally never matched
    // a row, so this returned []). Use the RESOLVED accessScopeId for the
    // principal and role lookups.
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope || scope.status === "disabled") return [];

    const principal = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!principal) return [];

    return collectPrincipalScopeRoles(ctx, {
      principalId: principal.principalId,
      scopeId: scope.accessScopeId,
    });
  },
});

export const getEffectivePermissions = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    ancestors: v.optional(
      v.array(v.object({ resourceType: v.string(), resourceId: v.string() })),
    ),
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

export const listScopeMemberDirectory = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ members: ScopeMemberDirectoryEntry[]; cursor?: string }> => {
    if (!(await callerHasScopePermission(ctx, args, "app.members:read"))) {
      return { members: [] };
    }
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return { members: [] };

    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("listScopeMemberDirectory limit must be an integer from 1 to 100");
    }

    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_status_type", (q) =>
        q
          .eq("accessScopeId", scope.accessScopeId)
          .eq("status", "active")
          .eq("type", "user"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const members = (
      await Promise.all(
        page.page.map(async (principal): Promise<ScopeMemberDirectoryEntry | null> => {
          if (!principal.herculesAuthUserId) return null;
          const user = await ctx.db
            .query("users")
            .withIndex("by_auth_user_id", (q) =>
              q.eq("herculesAuthUserId", principal.herculesAuthUserId!),
            )
            .unique();
          if (!user) return null;
          const roles = await collectPrincipalScopeRoles(ctx, {
            principalId: principal.principalId,
            scopeId: scope.accessScopeId,
          });
          return {
            principalId: principal.principalId,
            herculesAuthUserId: principal.herculesAuthUserId,
            name: user.name,
            email: user.email,
            ...(user.image === undefined ? {} : { image: user.image }),
            roleKeys: roles.map((role) => role.roleKey),
          };
        }),
      )
    ).filter((member): member is ScopeMemberDirectoryEntry => member !== null);

    return {
      members,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const getScopeMemberDirectoryEntry = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
    principalId: v.optional(v.string()),
    herculesAuthUserId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ScopeMemberDirectoryEntry | null> => {
    if ((args.principalId === undefined) === (args.herculesAuthUserId === undefined)) {
      throw new Error("getScopeMemberDirectoryEntry requires exactly one of principalId or herculesAuthUserId");
    }
    if (!(await callerHasScopePermission(ctx, args, "app.members:read"))) {
      return null;
    }
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return null;

    const principal = args.principalId
      ? await ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) => q.eq("principalId", args.principalId!))
          .unique()
      : await ctx.db
          .query("principals")
          .withIndex("by_scope_auth_user", (q) =>
            q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", args.herculesAuthUserId),
          )
          .unique();
    if (
      !principal ||
      principal.accessScopeId !== scope.accessScopeId ||
      principal.type !== "user" ||
      principal.status !== "active" ||
      !principal.herculesAuthUserId
    ) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", principal.herculesAuthUserId!))
      .unique();
    if (!user) return null;
    const roles = await collectPrincipalScopeRoles(ctx, {
      principalId: principal.principalId,
      scopeId: scope.accessScopeId,
    });

    return {
      principalId: principal.principalId,
      herculesAuthUserId: principal.herculesAuthUserId,
      name: user.name,
      email: user.email,
      ...(user.image === undefined ? {} : { image: user.image }),
      roleKeys: roles.map((role) => role.roleKey),
    };
  },
});

export const listScopeMembers = query({
  args: { tokenIdentifier: v.optional(v.string()), scopeId: v.string() },
  handler: async (ctx, args): Promise<ScopeMember[]> => {
    if (!(await callerHasScopePermission(ctx, args, "system.members:read"))) return [];
    const scope = await resolveScopeRow(ctx, args.scopeId);
    if (!scope) return [];

    // Both principal kinds are listed: user members AND groups. A user's
    // name/email/image resolve from the deployment-wide user row; a group's
    // name is the group's own display name carried on the principal row.
    const principals = await ctx.db
      .query("principals")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", scope.accessScopeId))
      .collect();

    const members: ScopeMember[] = [];
    for (const principal of principals) {
      let name: string | undefined;
      let email: string | undefined;
      let image: string | undefined;
      if (principal.type === "group") {
        name = principal.name;
      }
      const authUserId = principal.herculesAuthUserId;
      if (principal.type === "user" && authUserId) {
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
        type: principal.type,
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

    // Tenant roles owned by THIS scope (source=tenant, accessScopeId=scope).
    const scopeRoles = await ctx.db
      .query("roles")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", scope.accessScopeId))
      .collect();
    // Deployment-wide reusable catalog roles (source system|iam) carry NO
    // accessScopeId in v3. They are app-wide and assignable inside any scope, so
    // surface them alongside the scope's own roles. When viewing the default
    // scope they are the scope's "own" roles (shared=false); inside an org they
    // are shared.
    const isDefaultScope = defaultScopeId !== undefined && defaultScopeId === scope.accessScopeId;
    const catalogRoles = await ctx.db
      .query("roles")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", undefined))
      .collect();

    const seen = new Set<string>();
    const roles: ScopeRoleSummary[] = [];
    for (const role of [...scopeRoles, ...catalogRoles]) {
      if (seen.has(role.roleId)) continue;
      seen.add(role.roleId);
      roles.push({
        roleId: role.roleId,
        roleKey: role.key,
        roleName: role.name,
        roleKind: roleKindFromSource(role.source),
        // A reusable catalog role (no accessScopeId) is "shared" when surfaced
        // inside a non-default scope; a scope's own tenant role is never shared.
        shared: role.accessScopeId === undefined && !isDefaultScope,
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
        classification: permission.classification,
        tenantAssignable: permission.tenantAssignable,
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));
  },
});

type DirectResourceSubject = {
  grantId: string;
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  // A user subject's name/email/image come from the deployment-wide user row;
  // a group subject's name is the group's own display name.
  name?: string;
  email?: string;
  image?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  effect: "allow" | "deny";
  appliesTo: "self" | "self_and_descendants";
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

    // "Who has a DIRECT binding on this exact resource" = the union of role
    // bindings and direct-permission bindings whose (resourceType, resourceId)
    // target is this exact resource. Type-wide bindings (resourceId undefined)
    // are intentionally excluded — this panel lists direct-on-this-resource
    // subjects only, mirroring the old exact-objectId `by_object_resource` read.
    const resourceRoleBindings = await ctx.db
      .query("role_bindings")
      .withIndex("by_scope_resource", (q) =>
        q
          .eq("accessScopeId", scope.accessScopeId)
          .eq("resourceType", args.resourceType)
          .eq("resourceId", args.resourceId),
      )
      .collect();
    const resourcePermissionBindings = await ctx.db
      .query("permission_bindings")
      .withIndex("by_scope_resource", (q) =>
        q
          .eq("accessScopeId", scope.accessScopeId)
          .eq("resourceType", args.resourceType)
          .eq("resourceId", args.resourceId),
      )
      .collect();

    // Normalize both binding kinds to a common shape. A role binding has no
    // effect (membership is additive) — report it as an "allow". A
    // direct-permission binding carries its own effect. Only principal-subject
    // bindings are reported (a role-subject permission binding has no
    // subjectPrincipalId), matching the old `if (!subjectPrincipalId) continue`.
    type ResourceBinding = {
      grantId: string;
      subjectPrincipalId: string;
      relationKind: "role" | "direct_permission";
      roleId?: string;
      permissionId?: string;
      effect: "allow" | "deny";
      appliesTo: "self" | "self_and_descendants";
      expiresAt?: number;
    };
    const grants: ResourceBinding[] = [
      ...resourceRoleBindings.map((binding) => ({
        grantId: binding.bindingId,
        subjectPrincipalId: binding.subjectPrincipalId,
        relationKind: "role" as const,
        roleId: binding.roleId,
        effect: "allow" as const,
        appliesTo: binding.appliesTo,
        expiresAt: binding.expiresAt,
      })),
      ...resourcePermissionBindings.flatMap((binding) =>
        binding.subjectPrincipalId
          ? [
              {
                grantId: binding.bindingId,
                subjectPrincipalId: binding.subjectPrincipalId,
                relationKind: "direct_permission" as const,
                permissionId: binding.permissionId,
                effect: binding.effect,
                appliesTo: binding.appliesTo,
                expiresAt: binding.expiresAt,
              },
            ]
          : [],
      ),
    ];

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
      if (!principal) continue;

      // Group subjects are listed by their own display name; user subjects
      // resolve name/email/image from the deployment-wide user row.
      let name: string | undefined;
      let email: string | undefined;
      let image: string | undefined;
      if (principal.type === "group") {
        name = principal.name;
      }
      const authUserId = principal.herculesAuthUserId;
      if (principal.type === "user" && authUserId) {
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
        grantId: grant.grantId,
        principalId: principal.principalId,
        type: principal.type,
        herculesAuthUserId: authUserId,
        name,
        email,
        image,
        status: principal.status,
        effect: grant.effect,
        appliesTo: grant.appliesTo,
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
  // Authorization treats the user and each directly joined group as subjects.
  // Reuse the E3-fenced expansion (effective.collectPrincipalIds): a membership
  // confers its group only when the group principal exists, is a group, lives in
  // this scope, and is active. A blocked/deleted group, or a row pointing at a
  // non-group principal, grants nothing here too.
  const subjectPrincipalIds = await collectPrincipalIds(ctx, {
    principalId: args.principalId,
    scopeId: args.scopeId,
  });

  const now = Date.now();
  const allowedRoleIds = new Set<string>();

  for (const subjectPrincipalId of subjectPrincipalIds) {
    // Scope-object role bindings (resourceType/resourceId undefined): who holds
    // which role on this scope. Role bindings are purely additive membership —
    // the wire carries no deny role binding (a removed membership is a delete).
    const roleBindings = await ctx.db
      .query("role_bindings")
      .withIndex("by_subject_scope_resource", (q) =>
        q
          .eq("subjectPrincipalId", subjectPrincipalId)
          .eq("accessScopeId", args.scopeId)
          .eq("resourceType", undefined)
          .eq("resourceId", undefined),
      )
      .collect();

    for (const binding of roleBindings) {
      if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) {
        continue;
      }
      allowedRoleIds.add(binding.roleId);
    }
  }

  const roles: RoleSummary[] = [];
  for (const roleId of allowedRoleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;
    roles.push({
      roleId: role.roleId,
      roleKey: role.key,
      roleName: role.name,
      roleKind: roleKindFromSource(role.source),
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
