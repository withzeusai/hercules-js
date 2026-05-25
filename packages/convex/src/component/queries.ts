import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { evaluateEffectiveAccess } from "./effective";
import schema from "./schema";

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
  roleId?: string;
  roleKey: string;
  roleName: string;
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
  permissions: string[];
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
      const primaryRole = roles[0]!;

      memberships.push({
        scopeId: scope.accessScopeId,
        scopeName: scope.name,
        kind: scope.kind,
        roleId: primaryRole.roleId,
        roleKey: primaryRole.roleKey,
        roleName: primaryRole.roleName,
        roles,
        joinedAt: principal.joinedAt,
        status: principal.status,
      });
    }

    return memberships;
  },
});

export const listMyRoles = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.string(),
  },
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
    return {
      allowed: evaluation.allowed,
      reasonCode: evaluation.reasonCode,
      sourceVersion: evaluation.sourceVersion,
      scopeId: evaluation.scopeId,
      principalId: evaluation.principalId,
      effectiveRoleIds: evaluation.effectiveRoleIds,
      permissions: evaluation.permissions.map((permission) => permission.key),
    };
  },
});

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
