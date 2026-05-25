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
    // DL16 resource grant fallback. When provided, authorize also walks
    // resource-object grants targeting this resource. App code passes these
    // via extractScope when the permission applies to a specific row.
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.tokenIdentifier) {
      return deny("missing_identity");
    }

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token) {
      return deny("invalid_identity");
    }

    const state = await ctx.db.query("sync_state").unique();

    // Authenticated mode (no permission requested): the SDK already
    // verified the JWT via Convex's auth provider before reaching us. If
    // the mirror has not bootstrapped yet (no projection sync delivered),
    // accept on token presence so cold-start flows like updateCurrentUser
    // work. The issuer-match sanity check kicks in as soon as the first
    // projection populates sync_state.
    if (!args.permission) {
      if (state && token.issuer !== state.expectedIssuer) {
        return deny("unexpected_issuer");
      }
      return allow(state?.sourceVersion ?? 0, undefined, []);
    }

    // Permission mode: the mirror must be ready, and the issuer must match.
    if (!state) {
      return deny("mirror_not_ready");
    }
    if (token.issuer !== state.expectedIssuer) {
      return deny("unexpected_issuer");
    }

    if (!args.scopeId) {
      return deny("scope_missing", state.sourceVersion);
    }

    // Default scope is needed to resolve system roles and the app-wide
    // permission catalog under DL15. Looked up once per authorize call.
    // The SDK's defaultScope helper passes a sentinel string for
    // single-tenant apps — translate it here to the actual default scope id.
    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    if (!defaultScope) {
      return deny("default_scope_missing", state.sourceVersion);
    }

    const effectiveScopeId =
      args.scopeId === "__hercules_default_scope__" ? defaultScope.accessScopeId : args.scopeId;
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

    // Permissions are app-wide; look up in the default scope.
    const permission = await ctx.db
      .query("permissions")
      .withIndex("by_scope_key", (q) =>
        q.eq("accessScopeId", defaultScope.accessScopeId).eq("key", args.permission!),
      )
      .unique();
    if (!permission) {
      return deny("permission_missing", state.sourceVersion, principal.principalId);
    }

    // Expand the principal set to include any groups this principal belongs
    // to (group-mediated grants).
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

    const now = Date.now();
    const isActiveGrant = (g: { expiresAt?: number }) => !g.expiresAt || g.expiresAt > now;

    // Walk active scope-object grants on this scope for the expanded
    // principal set. Collect role grants (relationKind="role") and direct
    // permission grants (relationKind="direct_permission") separately.
    const effectiveRoleIds: string[] = [];
    const directAllowPermissionIds = new Set<string>();
    const directDenyPermissionIds = new Set<string>();
    for (const pid of principalIds) {
      const grants = await ctx.db
        .query("grants")
        .withIndex("by_subject_principal_object", (q) =>
          q
            .eq("subjectPrincipalId", pid)
            .eq("objectType", "scope")
            .eq("objectId", scope.accessScopeId),
        )
        .collect();
      for (const grant of grants) {
        if (!isActiveGrant(grant)) continue;
        if (grant.relationKind === "role" && grant.roleId) {
          effectiveRoleIds.push(grant.roleId);
        } else if (grant.relationKind === "direct_permission" && grant.permissionId) {
          if (grant.effect === "allow") {
            directAllowPermissionIds.add(grant.permissionId);
          } else {
            directDenyPermissionIds.add(grant.permissionId);
          }
        }
      }
    }

    // DL16 resource grant fallback. When app code passes resourceType +
    // resourceId, also walk grants whose object is the specific resource.
    if (args.resourceType && args.resourceId) {
      for (const pid of principalIds) {
        const resourceGrants = await ctx.db
          .query("grants")
          .withIndex("by_subject_principal_object_resource", (q) =>
            q
              .eq("subjectPrincipalId", pid)
              .eq("objectType", "resource")
              .eq("objectResourceType", args.resourceType!)
              .eq("objectId", args.resourceId!),
          )
          .collect();
        for (const grant of resourceGrants) {
          if (!isActiveGrant(grant)) continue;
          if (grant.objectScopeId !== scope.accessScopeId) continue;
          if (grant.relationKind === "role" && grant.roleId) {
            effectiveRoleIds.push(grant.roleId);
          } else if (grant.relationKind === "direct_permission" && grant.permissionId) {
            if (grant.effect === "allow") {
              directAllowPermissionIds.add(grant.permissionId);
            } else {
              directDenyPermissionIds.add(grant.permissionId);
            }
          }
        }
      }
    }

    // DL15.3 step 3 — resolve each assigned role to its effective permission
    // set. System role definitions live in the default scope; custom roles
    // and per-org overrides live in the target scope.
    let allowedViaRole = false;
    for (const roleId of effectiveRoleIds) {
      const roleRow = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique();
      if (!roleRow) continue;

      // Base mapping: where the role lives, look up role_permissions for
      // this permission with effect=allow.
      const baseAllow = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission_effect", (q) =>
          q
            .eq("accessScopeId", roleRow.accessScopeId)
            .eq("roleId", roleId)
            .eq("permissionId", permission.permissionId)
            .eq("effect", "allow"),
        )
        .unique();

      // For system roles (role lives in default scope), also apply org
      // scope's override rows: allow can add, deny can remove.
      if (roleRow.kind === "system" && scope.accessScopeId !== defaultScope.accessScopeId) {
        const orgDeny = await ctx.db
          .query("role_permissions")
          .withIndex("by_role_permission_effect", (q) =>
            q
              .eq("accessScopeId", scope.accessScopeId)
              .eq("roleId", roleId)
              .eq("permissionId", permission.permissionId)
              .eq("effect", "deny"),
          )
          .unique();
        if (orgDeny) continue;
        const orgAllow = await ctx.db
          .query("role_permissions")
          .withIndex("by_role_permission_effect", (q) =>
            q
              .eq("accessScopeId", scope.accessScopeId)
              .eq("roleId", roleId)
              .eq("permissionId", permission.permissionId)
              .eq("effect", "allow"),
          )
          .unique();
        if (baseAllow || orgAllow) {
          allowedViaRole = true;
          break;
        }
      } else if (baseAllow) {
        allowedViaRole = true;
        break;
      }
    }

    // DL15.3 step 4 — apply per-user direct grants last.
    // Policy lock (DL15.6a): direct user grants win over role-level overrides.
    // A direct allow re-enables a permission blocked by an org deny override;
    // a direct deny removes a permission a role granted.
    if (directDenyPermissionIds.has(permission.permissionId)) {
      return deny(
        "permission_denied",
        state.sourceVersion,
        principal.principalId,
        effectiveRoleIds,
      );
    }
    if (directAllowPermissionIds.has(permission.permissionId)) {
      return allow(state.sourceVersion, principal.principalId, effectiveRoleIds);
    }

    if (allowedViaRole) {
      return allow(state.sourceVersion, principal.principalId, effectiveRoleIds);
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
