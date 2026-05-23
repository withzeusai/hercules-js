import { queryGeneric, type DataModelFromSchemaDefinition, type QueryBuilder } from "convex/server";
import { v } from "convex/values";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

export const authorize = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.optional(v.string()),
    permission: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.tokenIdentifier) {
      return deny("missing_identity");
    }

    const state = await ctx.db.query("sync_state").unique();
    if (!state) {
      return deny("mirror_not_ready");
    }

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) {
      return deny("unexpected_issuer");
    }

    if (!args.permission) {
      return allow(state.sourceVersion, undefined, []);
    }

    if (!args.scopeId) {
      return deny("scope_missing", state.sourceVersion);
    }

    const scope = await ctx.db
      .query("scopes")
      .withIndex("by_scope_id", (q) => q.eq("accessScopeId", args.scopeId!))
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

    const permission = await ctx.db
      .query("permissions")
      .withIndex("by_scope_key", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("key", args.permission!),
      )
      .unique();
    if (!permission) {
      return deny("permission_missing", state.sourceVersion, principal.principalId);
    }

    const principalIds = [principal.principalId];
    const memberships = await ctx.db
      .query("principal_memberships")
      .withIndex("by_member", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("memberPrincipalId", principal.principalId),
      )
      .collect();
    for (const membership of memberships) {
      principalIds.push(membership.groupPrincipalId);
    }

    // V2 grants traversal (DL14.4 step 3, fast path). For this chunk authorize
    // only exercises principal-subject + scope-object grants; resource-object
    // and scope-subject grants are stored but not traversed yet (no producer
    // path emits them today, and no public surface for them).
    const effectiveRoleIds: string[] = [];
    for (const principalId of principalIds) {
      const grants = await ctx.db
        .query("grants")
        .withIndex("by_subject_principal_object", (q) =>
          q
            .eq("subjectPrincipalId", principalId)
            .eq("objectType", "scope")
            .eq("objectId", scope.accessScopeId),
        )
        .collect();
      for (const grant of grants) {
        effectiveRoleIds.push(grant.roleId);
      }
    }

    for (const roleId of effectiveRoleIds) {
      const rolePermissions = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q
            .eq("accessScopeId", scope.accessScopeId)
            .eq("roleId", roleId)
            .eq("permissionId", permission.permissionId),
        )
        .collect();
      if (rolePermissions.length > 0) {
        return allow(state.sourceVersion, principal.principalId, effectiveRoleIds);
      }
    }

    return deny("permission_denied", state.sourceVersion, principal.principalId, effectiveRoleIds);
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

function allow(sourceVersion: number, principalId: string | undefined, effectiveRoleIds: string[]) {
  return {
    allowed: true as const,
    reasonCode: "allowed",
    sourceVersion,
    principalId,
    effectiveRoleIds,
  };
}

function deny(
  reasonCode: string,
  sourceVersion?: number,
  principalId?: string,
  effectiveRoleIds?: string[],
) {
  return {
    allowed: false as const,
    reasonCode,
    sourceVersion,
    principalId,
    effectiveRoleIds: effectiveRoleIds ?? [],
  };
}
