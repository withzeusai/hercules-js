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

      // Single principal-subject scope-object grant per (principal, scope)
      // is the V1 invariant; unique() throws if anything double-writes so
      // we surface invariant violations loudly rather than picking one.
      const grant = await ctx.db
        .query("grants")
        .withIndex("by_subject_principal_object", (q) =>
          q
            .eq("subjectPrincipalId", principal.principalId)
            .eq("objectType", "scope")
            .eq("objectId", principal.accessScopeId),
        )
        .unique();
      if (!grant) continue;

      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", grant.roleId))
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
