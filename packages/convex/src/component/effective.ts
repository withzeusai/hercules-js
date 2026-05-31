import type { DataModelFromSchemaDefinition, GenericQueryCtx } from "convex/server";
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

export type EffectiveAccessEvaluation = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  scopeId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  permissions: PermissionSummary[];
  catalogPermissionKeys: Set<string>;
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
  const catalogPermissionKeys = new Set(catalogPermissions.map((permission) => permission.key));

  const principalIds = await collectPrincipalIds(ctx, {
    principalId: principal.principalId,
    scopeId: scope.accessScopeId,
  });

  const grantContributions = await collectGrantContributions(ctx, {
    principalIds,
    scopeId: scope.accessScopeId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
  });

  const roleAllowedPermissionIds = await collectRolePermissionIds(ctx, {
    roleIds: grantContributions.roleIds,
    targetScopeId: scope.accessScopeId,
    defaultScopeId: defaultScope.accessScopeId,
  });

  const allowedPermissionIds = new Set([
    ...roleAllowedPermissionIds,
    ...grantContributions.directAllowPermissionIds,
  ]);
  for (const deniedPermissionId of grantContributions.directDenyPermissionIds) {
    allowedPermissionIds.delete(deniedPermissionId);
  }

  const permissions = catalogPermissions
    .filter((permission) => allowedPermissionIds.has(permission.permissionId))
    .map((permission) => ({
      permissionId: permission.permissionId,
      key: permission.key,
      resourceType: permission.resourceType,
      action: permission.action,
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));

  return {
    allowed: true,
    reasonCode: "allowed",
    sourceVersion: state.sourceVersion,
    scopeId: scope.accessScopeId,
    principalId: principal.principalId,
    effectiveRoleIds: grantContributions.roleIds,
    permissions,
    catalogPermissionKeys,
  };
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

async function collectGrantContributions(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    principalIds: string[];
    scopeId: string;
    resourceType?: string;
    resourceId?: string;
  },
) {
  const now = Date.now();
  const roleIds = new Set<string>();
  const directAllowPermissionIds = new Set<string>();
  const directDenyPermissionIds = new Set<string>();

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
        collect(allResourceGrants.filter((grant) => grant.appliesToAllResources !== false));
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
        collect(allResourceGrants.filter((grant) => grant.appliesToAllResources !== false));
      }
    }
  }

  return {
    roleIds: effectiveRoleIds,
    directAllowPermissionIds,
    directDenyPermissionIds,
  };

  function collect(
    grants: Array<{
      relationKind: "role" | "direct_permission";
      roleId?: string;
      permissionId?: string;
      effect: "allow" | "deny";
      expiresAt?: number;
    }>,
  ) {
    for (const grant of grants) {
      if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) continue;
      if (grant.relationKind === "role") {
        if (grant.effect === "allow" && typeof grant.roleId === "string") {
          roleIds.add(grant.roleId);
        }
        continue;
      }
      if (typeof grant.permissionId !== "string") continue;
      if (grant.effect === "allow") {
        directAllowPermissionIds.add(grant.permissionId);
      } else {
        directDenyPermissionIds.add(grant.permissionId);
      }
    }
  }
}

async function collectRolePermissionIds(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleIds: string[]; targetScopeId: string; defaultScopeId: string },
) {
  const allowedPermissionIds = new Set<string>();

  for (const roleId of args.roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;

    const contribution = await collectRoleContribution(ctx, {
      roleId,
      roleScopeId: role.accessScopeId,
    });

    if (role.kind === "system" && args.targetScopeId !== args.defaultScopeId) {
      const overrideRows = await ctx.db
        .query("role_permissions")
        .withIndex("by_role", (q) => q.eq("accessScopeId", args.targetScopeId).eq("roleId", roleId))
        .collect();
      for (const row of overrideRows) {
        if (row.effect === "allow") {
          contribution.add(row.permissionId);
        } else {
          contribution.delete(row.permissionId);
        }
      }
    }

    for (const permissionId of contribution) {
      allowedPermissionIds.add(permissionId);
    }
  }

  return allowedPermissionIds;
}

async function collectRoleContribution(
  ctx: GenericQueryCtx<DataModel>,
  args: { roleId: string; roleScopeId: string },
) {
  const contribution = new Set<string>();
  const rows = await ctx.db
    .query("role_permissions")
    .withIndex("by_role", (q) => q.eq("accessScopeId", args.roleScopeId).eq("roleId", args.roleId))
    .collect();
  for (const row of rows) {
    if (row.effect === "allow") {
      contribution.add(row.permissionId);
    } else {
      contribution.delete(row.permissionId);
    }
  }
  return contribution;
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
    permissions: [],
    catalogPermissionKeys: new Set(),
  };
}
