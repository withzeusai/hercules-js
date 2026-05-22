import { queryGeneric, type DataModelFromSchemaDefinition, type QueryBuilder } from "convex/server";
import { v } from "convex/values";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

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

    const memberships: Array<{
      scopeId: string;
      scopeName: string;
      kind: "default" | "org" | "suite";
      roleKey: string;
      roleName: string;
      joinedAt: number;
      status: "active" | "blocked" | "suspended" | "pending_approval";
    }> = [];

    for (const principal of principals) {
      const scope = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", principal.accessScopeId))
        .unique();
      if (!scope) continue;
      if (scope.status === "disabled") continue;

      const assignment = await ctx.db
        .query("role_assignments")
        .withIndex("by_principal_target", (q) =>
          q
            .eq("accessScopeId", principal.accessScopeId)
            .eq("principalId", principal.principalId)
            .eq("targetType", "scope")
            .eq("targetId", principal.accessScopeId),
        )
        .unique();
      if (!assignment) continue;

      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", assignment.roleId))
        .unique();
      if (!role) continue;

      memberships.push({
        scopeId: scope.accessScopeId,
        scopeName: scope.name,
        kind: scope.kind,
        roleKey: role.key,
        roleName: role.name,
        joinedAt: principal.joinedAt,
        status: principal.status,
      });
    }

    return memberships;
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
