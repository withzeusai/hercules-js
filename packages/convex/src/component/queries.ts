import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { entryMatches, isOwnerOnlyLever } from "./authz";
import {
  evaluatePermissionDecision,
  evaluatePermissionDecisionDetailed,
  type PermissionDecisionDetails,
} from "./checks";
import {
  type AccessEntrySource,
  type AccessGrantSubject,
  type AccessGrantTarget,
  type AccessGrantTrace,
  collectPrincipalIds,
  enumeratePermissions,
  evaluateEffectiveAccess,
  type RuntimeEntry,
  resolveEffectiveWildcard,
  resolveRoleNetPermissionIds,
} from "./effective";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

const DEFAULT_TENANT_SENTINEL = "__hercules_default_tenant__";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// Public within the component boundary (parent-facing API; see checks.ts).
const query = queryGeneric as QueryBuilder<DataModel, "public">;

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

type DirectRoleGrant = RoleSummary & {
  grantId: string;
  type: "role";
  expiresAt: number | null;
};

// The external RoleSummary surface still reports `roleKind: "system" | "custom"`
// (client/index.ts + the generated component shape). Only platform-owned
// system roles are system; IAM-authored and tenant-authored roles are custom.
function roleKindFromSource(source: "system" | "iam" | "tenant"): "system" | "custom" {
  return source === "system" ? "system" : "custom";
}

type TenantSummary = {
  tenantId: string;
  tenantName: string;
  kind: "default" | "custom";
  roles: RoleSummary[];
  joinedAt: number;
  accessStatus: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  lifecycleStatus: "active" | "archived";
};

type ActiveTenantSummary = Omit<TenantSummary, "accessStatus" | "lifecycleStatus"> & {
  accessStatus: "active";
  lifecycleStatus: "active";
};

type TenantSummariesPage = {
  tenants: TenantSummary[];
  cursor?: string;
};

type ActiveTenantSummariesPage = {
  tenants: ActiveTenantSummary[];
  cursor?: string;
};

type TargetTenantSyncStatus =
  | {
      state: "syncing";
      currentSourceVersion?: number;
      targetSourceVersion: number;
    }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      principalId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      principalId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  tenantId?: string;
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

type TenantUserDirectoryEntry = {
  userId: string;
  name: string;
  email: string;
  image?: string;
  roles: RoleSummary[];
};

type TenantMemberPickerUser = {
  userId: string;
  name: string;
  email: string;
  image?: string;
};

type TenantMemberPickerUsersPage = {
  users: TenantMemberPickerUser[];
  cursor?: string;
};

type SharingRecipient =
  | {
      type: "user";
      userId: string;
      name: string;
      email: string;
      image?: string;
    }
  | {
      type: "group";
      groupId: string;
      name?: string;
    };

type SharingRecipientsPage = {
  recipients: SharingRecipient[];
  cursor?: string;
};

type TenantUser = {
  userId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleGrants: DirectRoleGrant[];
};

type TenantGroup = {
  groupId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  memberCount: number;
  name?: string;
  roles: RoleSummary[];
  directRoleGrants: DirectRoleGrant[];
};

type TenantUsersPage = { users: TenantUser[]; cursor?: string };
type TenantGroupsPage = { groups: TenantGroup[]; cursor?: string };

type TenantDetail = {
  tenantId: string;
  tenantName: string;
  kind: "default" | "custom";
  lifecycleStatus: "active" | "archived";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

type TenantRoleSummary = RoleSummary & {
  // True when the role is an app-wide shared role (default scope) surfaced as
  // assignable inside an org scope, rather than a role owned by this scope.
  shared: boolean;
};

type TenantPermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

type TenantRolePermission = TenantPermissionSummary & {
  effect: "allow" | "deny";
};

type TenantRoleDetail = TenantRoleSummary & {
  description: string | null;
  basePermissions: TenantRolePermission[];
  tenantOverrides: TenantRolePermission[];
  effectivePermissions: TenantPermissionSummary[];
};

type ResourcePermissionOverrideSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

type ResourcePermissionOverrideTarget = { type: "all" } | { type: "resource"; resourceId: string };

type ResourcePermissionOverridesResult = {
  tenantId: string;
  subject: ResourcePermissionOverrideSubject;
  resourceType: string;
  target: ResourcePermissionOverrideTarget;
  grants: DirectResourcePermissionGrant[];
};

type ExplainAccessTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      ancestors?: Array<{ resourceType: string; resourceId: string }>;
    };

type ExplainGrantSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

type ExplainGrantSource = {
  grantId: string;
  grantType: "role" | "permission";
  subject: ExplainGrantSubject;
  roleId?: string;
  permissionId?: string;
  permissionKey?: string;
  effect: "allow" | "deny";
  target: AccessGrantTarget;
  appliesTo: "self" | "self_and_descendants";
  expiresAt: number | null;
  inherited: boolean;
};

type ExplainRoleSource = {
  roleId: string;
  roleKey: string;
  roleName: string;
  description: string | null;
  wildcard: "none" | "immutable" | "default";
  permissionEffect: "allow" | "deny" | null;
  grantIds: string[];
  viaGroupIds: string[];
};

type ExplainRoleOverrideSource = {
  roleId: string;
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
};

type ExplainEntryOrigin =
  | { kind: "role_permission"; roleId: string }
  | {
      kind: "permission_grant";
      grantId: string;
      subject: ExplainGrantSubject;
      inherited: boolean;
    }
  | {
      kind: "resource_role";
      grantId: string;
      roleId: string;
      subject: ExplainGrantSubject;
      inherited: boolean;
    };

type ExplainEntrySource = {
  resourceType: string;
  action: string;
  objectType: "tenant" | "resource";
  objectId?: string;
  source?: ExplainEntryOrigin;
};

type ExplainAccessResult = {
  tenantId: string;
  userId: string;
  permission: string;
  target: ExplainAccessTarget;
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  decisiveReason: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
  sources: {
    directGrants: ExplainGrantSource[];
    groupMemberships: Array<{
      groupId: string;
      groupName?: string;
      status?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
      active: boolean;
    }>;
    roles: ExplainRoleSource[];
    roleOverrides: ExplainRoleOverrideSource[];
    resourceGrants: ExplainGrantSource[];
    ancestorGrants: ExplainGrantSource[];
    explicitDenies: ExplainEntrySource[];
    expiredIgnoredGrants: ExplainGrantSource[];
  };
};

export const getTenantAccessStatus = query({
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
        reason: "default_tenant_missing" as const,
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

export const listMyTenants = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantSummariesPage> => {
    if (!args.tokenIdentifier) return { tenants: [] };

    const state = await ctx.db.query("sync_state").unique();
    if (!state) return { tenants: [] };

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return { tenants: [] };

    const defaultStanding = await resolveDefaultUserPrincipal(ctx, token.subject);
    const hasActiveDefaultStanding =
      defaultStanding?.scope.status === "active" && defaultStanding.principal.status === "active";

    const limit = pageLimit("listMyTenants", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("herculesAuthUserId", token.subject))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const tenants = (
      await Promise.all(
        page.page.map(async (principal): Promise<TenantSummary | null> => {
          const scope = await ctx.db
            .query("scopes")
            .withIndex("by_scope_id", (q) => q.eq("accessScopeId", principal.accessScopeId))
            .unique();
          if (!scope) return null;
          const isDefaultPrincipal =
            defaultStanding !== null &&
            principal.accessScopeId === defaultStanding.scope.accessScopeId &&
            principal.principalId === defaultStanding.principal.principalId;
          if (!isDefaultPrincipal && !hasActiveDefaultStanding) return null;
          if (
            scope.status === "disabled" &&
            (principal.status !== "active" ||
              !(await principalHasDirectImmutableOwnerRole(ctx, {
                principalId: principal.principalId,
                scopeId: principal.accessScopeId,
              })))
          ) {
            return null;
          }

          const roles = await collectPrincipalScopeRoles(ctx, {
            principalId: principal.principalId,
            scopeId: principal.accessScopeId,
          });

          return {
            tenantId: scope.accessScopeId,
            tenantName: scope.name,
            kind: scope.kind === "default" ? "default" : "custom",
            roles,
            joinedAt: principal.joinedAt,
            accessStatus: principal.status,
            lifecycleStatus: publicTenantLifecycleStatus(scope.status),
          };
        }),
      )
    ).filter((tenant): tenant is TenantSummary => tenant !== null);

    return {
      tenants,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

const ACTIVE_TENANT_SCAN_CAP = 500;

export const listMyActiveTenants = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("default"), v.literal("custom"))),
  },
  handler: async (ctx, args): Promise<ActiveTenantSummariesPage> => {
    if (!args.tokenIdentifier) return { tenants: [] };

    const state = await ctx.db.query("sync_state").unique();
    if (!state) return { tenants: [] };

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return { tenants: [] };

    const defaultStanding = await resolveDefaultUserPrincipal(ctx, token.subject);
    if (
      defaultStanding?.scope.status !== "active" ||
      defaultStanding.principal.status !== "active"
    ) {
      return { tenants: [] };
    }

    const limit = pageLimit("listMyActiveTenants", args.limit);
    const tenants: ActiveTenantSummary[] = [];
    let cursor: string | null = args.cursor ?? null;
    let scanned = 0;
    let nextCursor: string | undefined;

    while (tenants.length < limit && scanned < ACTIVE_TENANT_SCAN_CAP) {
      const remainingResults = limit - tenants.length;
      const remainingScan = ACTIVE_TENANT_SCAN_CAP - scanned;
      const page = await paginator(ctx.db, schema)
        .query("principals")
        .withIndex("by_auth_user_status", (q) =>
          q.eq("herculesAuthUserId", token.subject).eq("status", "active"),
        )
        .paginate({ cursor, numItems: Math.min(remainingResults, remainingScan) });

      scanned += page.page.length;
      nextCursor = page.isDone ? undefined : page.continueCursor;

      for (const principal of page.page) {
        const scope = await ctx.db
          .query("scopes")
          .withIndex("by_scope_id", (q) => q.eq("accessScopeId", principal.accessScopeId))
          .unique();
        if (!scope || scope.status !== "active") continue;
        const kind = scope.kind === "default" ? "default" : "custom";
        if (args.kind && args.kind !== kind) continue;

        const roles = await collectPrincipalScopeRoles(ctx, {
          principalId: principal.principalId,
          scopeId: principal.accessScopeId,
        });
        tenants.push({
          tenantId: scope.accessScopeId,
          tenantName: scope.name,
          kind,
          roles,
          joinedAt: principal.joinedAt,
          accessStatus: "active",
          lifecycleStatus: "active",
        });
      }

      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    return {
      tenants,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    };
  },
});

export const getTargetTenantSyncStatus = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args): Promise<TargetTenantSyncStatus> => {
    const targetSourceVersion = args.sourceVersion;
    const state = await ctx.db.query("sync_state").unique();
    if (!state) {
      return { state: "syncing", targetSourceVersion };
    }

    if (state.sourceVersion < targetSourceVersion) {
      return {
        state: "syncing",
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
      };
    }

    if (!args.tokenIdentifier) {
      return syncFailed("identity_missing", state.sourceVersion, targetSourceVersion);
    }
    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token) {
      return syncFailed("identity_invalid", state.sourceVersion, targetSourceVersion);
    }
    if (token.issuer !== state.expectedIssuer) {
      return syncFailed("unexpected_issuer", state.sourceVersion, targetSourceVersion);
    }

    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) {
      return syncFailed("tenant_missing", state.sourceVersion, targetSourceVersion);
    }

    const evaluation = await evaluateEffectiveAccess(ctx, {
      tokenIdentifier: args.tokenIdentifier,
      scopeId: args.tenantId,
    });
    if (evaluation.allowed && evaluation.scopeId && evaluation.principalId) {
      return {
        state: "ready",
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
        tenantId: evaluation.scopeId,
        principalId: evaluation.principalId,
      };
    }

    if (isCompletedAccessDenial(evaluation.reasonCode)) {
      return {
        state: "denied",
        reasonCode: evaluation.reasonCode,
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
        ...(evaluation.scopeId === undefined ? {} : { tenantId: evaluation.scopeId }),
        ...(evaluation.principalId === undefined ? {} : { principalId: evaluation.principalId }),
      };
    }

    return syncFailed(evaluation.reasonCode, state.sourceVersion, targetSourceVersion);
  },
});

export const listMyRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.string() },
  handler: async (ctx, args): Promise<RoleSummary[]> => {
    if (!args.tokenIdentifier) return [];

    const state = await ctx.db.query("sync_state").unique();
    if (!state) return [];

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return [];

    // Resolve the tenant through the persistence adapter so the default
    // sentinel maps to the real default scope row.
    const scope = await resolveScopeRow(ctx, args.tenantId);
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
    tenantId: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    ancestors: v.optional(v.array(v.object({ resourceType: v.string(), resourceId: v.string() }))),
  },
  handler: async (ctx, args): Promise<EffectivePermissionsResult> => {
    const evaluation = await evaluateEffectiveAccess(ctx, {
      ...args,
      scopeId: args.tenantId,
    });
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
      tenantId: evaluation.scopeId,
      principalId: evaluation.principalId,
      effectiveRoleIds: evaluation.effectiveRoleIds,
      wildcard: evaluation.wildcard,
      permissions: permissions.map((permission) => permission.key),
    };
  },
});

export const listTenantUserDirectory = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ users: TenantUserDirectoryEntry[]; cursor?: string }> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return { users: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { users: [] };

    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("listTenantUserDirectory limit must be an integer from 1 to 100");
    }

    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_status_type", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("status", "active").eq("type", "user"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const users = (
      await Promise.all(
        page.page.map(async (principal): Promise<TenantUserDirectoryEntry | null> => {
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
            userId: principal.herculesAuthUserId,
            name: user.name,
            email: user.email,
            ...(user.image === undefined ? {} : { image: user.image }),
            roles,
          };
        }),
      )
    ).filter((user): user is TenantUserDirectoryEntry => user !== null);

    return {
      users,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const listTenantMemberPickerUsers = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    permission: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    ancestors: v.optional(v.array(v.object({ resourceType: v.string(), resourceId: v.string() }))),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantMemberPickerUsersPage> => {
    const decision = await evaluatePermissionDecision(ctx, {
      tokenIdentifier: args.tokenIdentifier,
      tenantId: args.tenantId,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      ancestors: args.ancestors,
    });
    if (!decision.allowed) return { users: [] };

    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { users: [] };

    const limit = pageLimit("listTenantMemberPickerUsers", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_status_type", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("status", "active").eq("type", "user"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const users = (
      await Promise.all(page.page.map((principal) => tenantPickerUserFromPrincipal(ctx, principal)))
    ).filter((user): user is TenantMemberPickerUser => user !== null);

    return {
      users,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const getTenantUserDirectoryEntry = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<TenantUserDirectoryEntry | null> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return null;
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return null;

    const principal = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", args.userId),
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
      userId: principal.herculesAuthUserId,
      name: user.name,
      email: user.email,
      ...(user.image === undefined ? {} : { image: user.image }),
      roles,
    };
  },
});

export const listResourceSharingRecipients = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    permission: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    ancestors: v.optional(v.array(v.object({ resourceType: v.string(), resourceId: v.string() }))),
    recipientType: v.union(v.literal("user"), v.literal("group")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SharingRecipientsPage> => {
    const details = await evaluatePermissionDecisionDetailed(ctx, {
      tokenIdentifier: args.tokenIdentifier,
      tenantId: args.tenantId,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      ancestors: args.ancestors,
    });
    if (
      !details.decision.allowed ||
      details.resolvedPermission?.resourceType !== args.resourceType ||
      details.resolvedPermission.action !== "manage_members"
    ) {
      return { recipients: [] };
    }

    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { recipients: [] };

    const limit = pageLimit("listResourceSharingRecipients", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_status_type", (q) =>
        q
          .eq("accessScopeId", scope.accessScopeId)
          .eq("status", "active")
          .eq("type", args.recipientType),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const recipients = (
      await Promise.all(page.page.map((principal) => sharingRecipientFromPrincipal(ctx, principal)))
    ).filter((recipient): recipient is SharingRecipient => recipient !== null);

    return {
      recipients,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const getTenant = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.string() },
  handler: async (ctx, args): Promise<TenantDetail | null> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) return null;
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return null;
    return {
      tenantId: scope.accessScopeId,
      tenantName: scope.name,
      kind: scope.kind === "default" ? "default" : "custom",
      lifecycleStatus: publicTenantLifecycleStatus(scope.status),
      accessMode: scope.accessMode,
      defaultRoleId: scope.defaultRoleId,
      updatedAt: scope.updatedAt,
    };
  },
});

export const listTenantUsers = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantUsersPage> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return { users: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { users: [] };

    const limit = pageLimit("listTenantUsers", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_type", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("type", "user"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const users = (
      await Promise.all(
        page.page.map((principal) => tenantUserFromPrincipal(ctx, principal, scope.accessScopeId)),
      )
    ).filter((user): user is TenantUser => user !== null);

    return {
      users,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const listTenantGroups = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantGroupsPage> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return { groups: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { groups: [] };

    const limit = pageLimit("listTenantGroups", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principals")
      .withIndex("by_scope_type", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("type", "group"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const groups = await Promise.all(
      page.page.map((principal) => tenantGroupFromPrincipal(ctx, principal, scope.accessScopeId)),
    );
    return {
      groups,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const listGroupMembers = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    groupId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantUsersPage> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return { users: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { users: [] };
    const group = await ctx.db
      .query("principals")
      .withIndex("by_principal_id", (q) => q.eq("principalId", args.groupId))
      .unique();
    if (!group || group.type !== "group" || group.accessScopeId !== scope.accessScopeId) {
      return { users: [] };
    }

    const limit = pageLimit("listGroupMembers", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principal_memberships")
      .withIndex("by_group", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("groupPrincipalId", group.principalId),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const users = (
      await Promise.all(
        page.page.map(async (membership) => {
          const principal = await ctx.db
            .query("principals")
            .withIndex("by_principal_id", (q) => q.eq("principalId", membership.memberPrincipalId))
            .unique();
          if (
            !principal ||
            principal.type !== "user" ||
            principal.accessScopeId !== scope.accessScopeId
          ) {
            return null;
          }
          return tenantUserFromPrincipal(ctx, principal, scope.accessScopeId);
        }),
      )
    ).filter((user): user is TenantUser => user !== null);
    users.sort((a, b) =>
      (a.name ?? a.email ?? a.userId).localeCompare(b.name ?? b.email ?? b.userId),
    );
    return {
      users,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const listUserGroups = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    userId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantGroupsPage> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.users:read"))) {
      return { groups: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { groups: [] };
    const user = await ctx.db
      .query("principals")
      .withIndex("by_scope_auth_user", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", args.userId),
      )
      .unique();
    if (!user || user.type !== "user") return { groups: [] };

    const limit = pageLimit("listUserGroups", args.limit);
    const page = await paginator(ctx.db, schema)
      .query("principal_memberships")
      .withIndex("by_member", (q) =>
        q.eq("accessScopeId", scope.accessScopeId).eq("memberPrincipalId", user.principalId),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const groups = (
      await Promise.all(
        page.page.map(async (membership) => {
          const group = await ctx.db
            .query("principals")
            .withIndex("by_principal_id", (q) => q.eq("principalId", membership.groupPrincipalId))
            .unique();
          if (!group || group.type !== "group" || group.accessScopeId !== scope.accessScopeId) {
            return null;
          }
          return tenantGroupFromPrincipal(ctx, group, scope.accessScopeId);
        }),
      )
    ).filter((group): group is TenantGroup => group !== null);
    groups.sort((a, b) => (a.name ?? a.groupId).localeCompare(b.name ?? b.groupId));
    return {
      groups,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const listTenantRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.string() },
  handler: async (ctx, args): Promise<TenantRoleSummary[]> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.roles:read"))) return [];
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return [];

    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    const defaultScopeId = defaultScope?.accessScopeId;

    // Tenant-owned roles for this persisted scope row.
    const scopeRoles = await ctx.db
      .query("roles")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", scope.accessScopeId))
      .collect();
    // Deployment-wide reusable catalog roles (source system|iam) carry NO
    // accessScopeId in v4. They are app-wide and assignable inside any tenant.
    const isDefaultScope = defaultScopeId !== undefined && defaultScopeId === scope.accessScopeId;
    const catalogRoles = await ctx.db
      .query("roles")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", undefined))
      .collect();

    const seen = new Set<string>();
    const roles: TenantRoleSummary[] = [];
    for (const role of [...scopeRoles, ...catalogRoles]) {
      if (seen.has(role.roleId)) continue;
      seen.add(role.roleId);
      roles.push({
        roleId: role.roleId,
        roleKey: role.key,
        roleName: role.name,
        roleKind: roleKindFromSource(role.source),
        // A reusable catalog role (no accessScopeId) is "shared" when surfaced
        // inside a non-default tenant; a tenant-owned role is never shared.
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

export const getTenantRole = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    roleId: v.string(),
  },
  handler: async (ctx, args): Promise<TenantRoleDetail | null> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.roles:read"))) return null;
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return null;
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", args.roleId))
      .unique();
    if (!role || (role.accessScopeId !== undefined && role.accessScopeId !== scope.accessScopeId)) {
      return null;
    }

    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    if (!defaultScope) return null;
    const [catalogPermissions, baseRows, overrideRows, contribution, wildcard] = await Promise.all([
      ctx.db
        .query("permissions")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScope.accessScopeId))
        .collect(),
      ctx.db
        .query("role_permissions")
        .withIndex("by_role", (q) => q.eq("roleId", role.roleId))
        .collect(),
      ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope_role", (q) =>
          q.eq("accessScopeId", scope.accessScopeId).eq("roleId", role.roleId),
        )
        .collect(),
      resolveRoleNetPermissionIds(ctx, {
        roleId: role.roleId,
        targetScopeId: scope.accessScopeId,
      }),
      resolveEffectiveWildcard(ctx, {
        role,
        targetScopeId: scope.accessScopeId,
      }),
    ]);
    if (!contribution) return null;

    const permissionById = new Map(
      catalogPermissions.map((permission) => [permission.permissionId, permission]),
    );
    const mapRows = (
      rows: Array<{ permissionId: string; effect: "allow" | "deny" }>,
    ): TenantRolePermission[] =>
      rows
        .flatMap((row) => {
          const permission = permissionById.get(row.permissionId);
          return permission ? [{ ...tenantPermissionSummary(permission), effect: row.effect }] : [];
        })
        .sort(
          (a, b) =>
            a.key.localeCompare(b.key) ||
            a.effect.localeCompare(b.effect) ||
            a.permissionId.localeCompare(b.permissionId),
        );

    const effectivePermissions = catalogPermissions
      .filter((permission) => {
        if (wildcard === "immutable") return true;
        if (contribution.deny.has(permission.permissionId)) return false;
        const ownerOnly = isOwnerOnlyLever({
          resourceType: permission.resourceType,
          action: permission.action,
          classification: permission.classification,
        });
        if (wildcard === "default") return !ownerOnly;
        return !ownerOnly && contribution.allow.has(permission.permissionId);
      })
      .map(tenantPermissionSummary)
      .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));

    return {
      ...roleSummary(role),
      description: role.description,
      shared:
        role.accessScopeId === undefined && scope.accessScopeId !== defaultScope.accessScopeId,
      basePermissions: mapRows(baseRows),
      tenantOverrides: mapRows(overrideRows),
      effectivePermissions,
    };
  },
});

export const listTenantPermissions = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.string() },
  handler: async (ctx, args): Promise<TenantPermissionSummary[]> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.permissions:read"))) return [];
    // The permission catalog is app-wide and stored with the default scope row.
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
      .map(tenantPermissionSummary)
      .sort((a, b) => a.key.localeCompare(b.key) || a.permissionId.localeCompare(b.permissionId));
  },
});

type DirectResourceRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourcePermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourceSubjectBase = {
  name?: string;
  email?: string;
  image?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
};

type DirectResourceSubject = DirectResourceSubjectBase &
  ({ type: "user"; userId: string } | { type: "group"; groupId: string }) &
  (
    | { grant: DirectResourceRoleGrant; role: RoleSummary }
    | { grant: DirectResourcePermissionGrant }
  );

type DirectResourceSubjectsPage = {
  subjects: DirectResourceSubject[];
  cursor?: string;
};

type DirectResourceBinding = {
  grantId: string;
  subjectPrincipalId: string;
  relationKind: "role" | "direct_permission";
  roleId?: string;
  permissionId?: string;
  effect?: "allow" | "deny";
  appliesTo: "self" | "self_and_descendants";
  expiresAt?: number;
};

// "Who has a DIRECT grant on this resource" for an in-app access panel.
// (e.g. "people on this project"). DIRECT grants only: this intentionally does
// NOT include principals who reach the resource via a tenant-wide role/wildcard
// or a parent resource. Listing IAM grants is an access-management operation,
// so the gate is fixed to the tenant-level grants-read capability instead of
// caller input.
export const listDirectSubjectsForResource = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DirectResourceSubjectsPage> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.grants:read"))) {
      return { subjects: [] };
    }
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return { subjects: [] };

    // "Who has a DIRECT binding on this exact resource" = the union of role
    // bindings and direct-permission bindings whose (resourceType, resourceId)
    // target is this exact resource. Type-wide bindings (resourceId undefined)
    // are intentionally excluded — this panel lists direct-on-this-resource
    // subjects only, mirroring the old exact-objectId `by_object_resource` read.
    const limit = pageLimit("listDirectSubjectsForResource", args.limit);
    const cursor = parseDirectResourceSubjectsCursor(args.cursor);
    const grants: DirectResourceBinding[] = [];
    let remaining = limit;
    let nextCursor: string | undefined;
    let permissionCursor: string | null | undefined =
      cursor.phase === "permission_bindings" ? cursor.cursor : undefined;

    if (cursor.phase === "role_bindings") {
      const page = await paginator(ctx.db, schema)
        .query("role_bindings")
        .withIndex("by_scope_resource", (q) =>
          q
            .eq("accessScopeId", scope.accessScopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", args.resourceId),
        )
        .paginate({ cursor: cursor.cursor, numItems: remaining });
      grants.push(
        ...page.page.map((binding) => ({
          grantId: binding.bindingId,
          subjectPrincipalId: binding.subjectPrincipalId,
          relationKind: "role" as const,
          roleId: binding.roleId,
          appliesTo: binding.appliesTo,
          expiresAt: binding.expiresAt,
        })),
      );
      remaining -= page.page.length;
      if (!page.isDone) {
        nextCursor = serializeDirectResourceSubjectsCursor({
          phase: "role_bindings",
          cursor: page.continueCursor,
        });
      } else if (remaining === 0) {
        nextCursor = serializeDirectResourceSubjectsCursor({
          phase: "permission_bindings",
          cursor: null,
        });
      } else {
        permissionCursor = null;
      }
    }

    if (permissionCursor !== undefined && remaining > 0) {
      const page = await paginator(ctx.db, schema)
        .query("permission_bindings")
        .withIndex("by_scope_resource", (q) =>
          q
            .eq("accessScopeId", scope.accessScopeId)
            .eq("resourceType", args.resourceType)
            .eq("resourceId", args.resourceId),
        )
        .paginate({ cursor: permissionCursor, numItems: remaining });
      // Only principal-subject bindings are reported. A role-subject permission
      // binding has no subjectPrincipalId and is not a user/group grant.
      grants.push(
        ...page.page.flatMap((binding) =>
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
      );
      if (!page.isDone) {
        nextCursor = serializeDirectResourceSubjectsCursor({
          phase: "permission_bindings",
          cursor: page.continueCursor,
        });
      } else {
        nextCursor = undefined;
      }
    }

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
      if (principal.type === "user" && !authUserId) continue;
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

      let directGrant:
        | { grant: DirectResourceRoleGrant; role: RoleSummary }
        | { grant: DirectResourcePermissionGrant }
        | undefined;
      if (grant.relationKind === "role" && grant.roleId) {
        const role = await ctx.db
          .query("roles")
          .withIndex("by_role_id", (q) => q.eq("roleId", grant.roleId!))
          .unique();
        if (role) {
          directGrant = {
            grant: {
              grantId: grant.grantId,
              type: "role",
              roleId: grant.roleId,
              appliesTo: grant.appliesTo,
              expiresAt: grant.expiresAt ?? null,
            },
            role: {
              roleId: role.roleId,
              roleKey: role.key,
              roleName: role.name,
              roleKind: roleKindFromSource(role.source),
            },
          };
        }
      } else if (grant.relationKind === "direct_permission" && grant.permissionId && grant.effect) {
        const permission = await ctx.db
          .query("permissions")
          .withIndex("by_permission_id", (q) => q.eq("permissionId", grant.permissionId!))
          .unique();
        if (permission) {
          directGrant = {
            grant: {
              grantId: grant.grantId,
              type: "permission",
              permissionId: grant.permissionId,
              permissionKey: permission.key,
              effect: grant.effect,
              appliesTo: grant.appliesTo,
              expiresAt: grant.expiresAt ?? null,
            },
          };
        }
      }
      if (!directGrant) continue;

      const common = {
        name,
        email,
        image,
        status: principal.status,
        ...directGrant,
      };
      results.push(
        principal.type === "user" && authUserId
          ? { ...common, type: "user", userId: authUserId }
          : { ...common, type: "group", groupId: principal.principalId },
      );
    }

    return {
      subjects: results,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    };
  },
});

export const getResourcePermissionOverrides = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    subject: v.union(
      v.object({ type: v.literal("user"), userId: v.string() }),
      v.object({ type: v.literal("group"), groupId: v.string() }),
      v.object({ type: v.literal("role"), roleId: v.string() }),
    ),
    resourceType: v.string(),
    target: v.union(
      v.object({ type: v.literal("all") }),
      v.object({ type: v.literal("resource"), resourceId: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<ResourcePermissionOverridesResult | null> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.grants:read"))) return null;
    const scope = await resolveScopeRow(ctx, args.tenantId);
    if (!scope) return null;

    let subjectPrincipalId: string | undefined;
    let subjectRoleId: string | undefined;
    if (args.subject.type === "user") {
      const userId = args.subject.userId;
      const principal = await ctx.db
        .query("principals")
        .withIndex("by_scope_auth_user", (q) =>
          q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", userId),
        )
        .unique();
      if (!principal || principal.type !== "user") return null;
      subjectPrincipalId = principal.principalId;
    } else if (args.subject.type === "group") {
      const groupId = args.subject.groupId;
      const principal = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", groupId))
        .unique();
      if (
        !principal ||
        principal.type !== "group" ||
        principal.accessScopeId !== scope.accessScopeId
      ) {
        return null;
      }
      subjectPrincipalId = principal.principalId;
    } else {
      const roleId = args.subject.roleId;
      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique();
      if (
        !role ||
        (role.accessScopeId !== undefined && role.accessScopeId !== scope.accessScopeId)
      ) {
        return null;
      }
      subjectRoleId = role.roleId;
    }

    const resourceId = args.target.type === "resource" ? args.target.resourceId : undefined;
    const bindings = subjectPrincipalId
      ? await ctx.db
          .query("permission_bindings")
          .withIndex("by_subject_principal_scope_resource", (q) =>
            q
              .eq("subjectPrincipalId", subjectPrincipalId)
              .eq("accessScopeId", scope.accessScopeId)
              .eq("resourceType", args.resourceType)
              .eq("resourceId", resourceId),
          )
          .collect()
      : await ctx.db
          .query("permission_bindings")
          .withIndex("by_subject_role_scope_resource", (q) =>
            q
              .eq("subjectRoleId", subjectRoleId)
              .eq("accessScopeId", scope.accessScopeId)
              .eq("resourceType", args.resourceType)
              .eq("resourceId", resourceId),
          )
          .collect();

    const now = Date.now();
    const grants = (
      await Promise.all(
        bindings.map(async (binding): Promise<DirectResourcePermissionGrant | null> => {
          if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) return null;
          const permission = await ctx.db
            .query("permissions")
            .withIndex("by_permission_id", (q) => q.eq("permissionId", binding.permissionId))
            .unique();
          if (!permission) return null;
          return {
            grantId: binding.bindingId,
            type: "permission",
            permissionId: permission.permissionId,
            permissionKey: permission.key,
            effect: binding.effect,
            appliesTo: binding.appliesTo,
            expiresAt: binding.expiresAt ?? null,
          };
        }),
      )
    )
      .filter((grant): grant is DirectResourcePermissionGrant => grant !== null)
      .sort(
        (a, b) =>
          a.permissionKey.localeCompare(b.permissionKey) || a.grantId.localeCompare(b.grantId),
      );

    return {
      tenantId: scope.accessScopeId,
      subject: args.subject,
      resourceType: args.resourceType,
      target: args.target,
      grants,
    };
  },
});

export const explainAccess = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.string(),
    userId: v.string(),
    permission: v.string(),
    target: v.union(
      v.object({ type: v.literal("tenant") }),
      v.object({
        type: v.literal("resource"),
        resourceType: v.string(),
        resourceId: v.string(),
        ancestors: v.optional(
          v.array(
            v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            }),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ExplainAccessResult | null> => {
    if (!(await callerHasTenantPermission(ctx, args, "system.access.grants:read"))) return null;
    if (!args.tokenIdentifier) return null;
    const caller = parseTokenIdentifier(args.tokenIdentifier);
    if (!caller) return null;

    const targetArgs =
      args.target.type === "tenant"
        ? {}
        : {
            resourceType: args.target.resourceType,
            resourceId: args.target.resourceId,
            ancestors: args.target.ancestors,
          };
    const details = await evaluatePermissionDecisionDetailed(ctx, {
      tokenIdentifier: `${caller.issuer}|${args.userId}`,
      tenantId: args.tenantId,
      permission: args.permission,
      ...targetArgs,
      includeTrace: true,
    });
    const sources = await buildExplainAccessSources(ctx, {
      userId: args.userId,
      details,
    });
    return {
      tenantId: details.evaluation?.scopeId ?? args.tenantId,
      userId: args.userId,
      permission: args.permission,
      target: args.target,
      ...details.decision,
      decisiveReason: details.accessResolution?.decisiveReason ?? details.decision.reasonCode,
      sources,
    };
  },
});

async function buildExplainAccessSources(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    userId: string;
    details: PermissionDecisionDetails;
  },
): Promise<ExplainAccessResult["sources"]> {
  const evaluation = args.details.evaluation;
  if (!evaluation) return emptyExplainAccessSources();

  const catalogById = new Map(
    evaluation.catalogPermissions.map((permission) => [permission.permissionId, permission]),
  );
  const trace = evaluation.trace;
  const appliedGrants = trace?.appliedGrants ?? [];
  const mapGrant = (grant: AccessGrantTrace): ExplainGrantSource => ({
    grantId: grant.grantId,
    grantType: grant.grantType,
    subject: explainGrantSubject(grant.subject, args.userId),
    ...(grant.roleId === undefined ? {} : { roleId: grant.roleId }),
    ...(grant.permissionId === undefined ? {} : { permissionId: grant.permissionId }),
    ...(grant.permissionId === undefined
      ? {}
      : {
          permissionKey: catalogById.get(grant.permissionId)?.key,
        }),
    effect: grant.effect,
    target: grant.target,
    appliesTo: grant.appliesTo,
    expiresAt: grant.expiresAt,
    inherited: grant.inherited,
  });
  const directGrants = appliedGrants
    .filter((grant) => grant.target.type === "tenant")
    .map(mapGrant)
    .sort(compareGrantSources);
  const resourceGrants = appliedGrants
    .filter((grant) => grant.target.type === "resource" && !grant.inherited)
    .map(mapGrant)
    .sort(compareGrantSources);
  const ancestorGrants = appliedGrants
    .filter((grant) => grant.target.type === "resource" && grant.inherited)
    .map(mapGrant)
    .sort(compareGrantSources);
  const expiredIgnoredGrants = (trace?.expiredIgnoredGrants ?? [])
    .map(mapGrant)
    .sort(compareGrantSources);

  const roleIds = new Set(evaluation.effectiveRoleIds);
  for (const grant of appliedGrants) {
    if (grant.roleId) roleIds.add(grant.roleId);
  }
  for (const entry of evaluation.entries) {
    const roleId = roleIdForEntry(entry);
    if (roleId) roleIds.add(roleId);
  }

  const roles: ExplainRoleSource[] = [];
  const roleOverrides: ExplainRoleOverrideSource[] = [];
  for (const roleId of roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!role) continue;
    const matchingEntries = args.details.request
      ? evaluation.entries.filter(
          (entry) => roleIdForEntry(entry) === roleId && entryMatches(entry, args.details.request!),
        )
      : [];
    const permissionEffect = matchingEntries.some((entry) => entry.effect === "deny")
      ? "deny"
      : matchingEntries.some((entry) => entry.effect === "allow")
        ? "allow"
        : null;
    const grants = appliedGrants.filter((grant) => grant.roleId === roleId);
    roles.push({
      roleId,
      roleKey: role.key,
      roleName: role.name,
      description: role.description,
      wildcard:
        evaluation.scopeId === undefined
          ? role.baseWildcard
          : await resolveEffectiveWildcard(ctx, {
              role,
              targetScopeId: evaluation.scopeId,
            }),
      permissionEffect,
      grantIds: [...new Set(grants.map((grant) => grant.grantId))].sort(),
      viaGroupIds: [
        ...new Set(
          grants.flatMap((grant) => (grant.subject.type === "group" ? [grant.subject.id] : [])),
        ),
      ].sort(),
    });

    if (evaluation.scopeId !== undefined && args.details.request) {
      const overrides = await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope_role", (q) =>
          q.eq("accessScopeId", evaluation.scopeId!).eq("roleId", roleId),
        )
        .collect();
      for (const override of overrides) {
        const permission = catalogById.get(override.permissionId);
        if (
          !permission ||
          !entryMatches(
            {
              effect: override.effect,
              resourceType: permission.resourceType,
              action: permission.action,
              objectType: "scope",
            },
            args.details.request,
          )
        ) {
          continue;
        }
        roleOverrides.push({
          roleId,
          permissionId: permission.permissionId,
          permissionKey: permission.key,
          effect: override.effect,
        });
      }
    }
  }
  roles.sort((a, b) => a.roleKey.localeCompare(b.roleKey) || a.roleId.localeCompare(b.roleId));
  roleOverrides.sort(
    (a, b) =>
      a.roleId.localeCompare(b.roleId) ||
      a.permissionKey.localeCompare(b.permissionKey) ||
      a.effect.localeCompare(b.effect),
  );

  const explicitDenies =
    args.details.request === undefined
      ? []
      : evaluation.entries
          .filter((entry) => entry.effect === "deny" && entryMatches(entry, args.details.request!))
          .map((entry) => ({
            resourceType: entry.resourceType,
            action: entry.action,
            objectType: entry.objectType === "scope" ? ("tenant" as const) : ("resource" as const),
            ...(entry.objectId === undefined ? {} : { objectId: entry.objectId }),
            ...(entry.source === undefined
              ? {}
              : { source: explainEntrySource(entry.source, args.userId) }),
          }));

  return {
    directGrants,
    groupMemberships: [...(trace?.groupMemberships ?? [])].sort((a, b) =>
      a.groupId.localeCompare(b.groupId),
    ),
    roles,
    roleOverrides,
    resourceGrants,
    ancestorGrants,
    explicitDenies,
    expiredIgnoredGrants,
  };
}

function emptyExplainAccessSources(): ExplainAccessResult["sources"] {
  return {
    directGrants: [],
    groupMemberships: [],
    roles: [],
    roleOverrides: [],
    resourceGrants: [],
    ancestorGrants: [],
    explicitDenies: [],
    expiredIgnoredGrants: [],
  };
}

function explainGrantSubject(subject: AccessGrantSubject, userId: string): ExplainGrantSubject {
  switch (subject.type) {
    case "user":
      return { type: "user", userId };
    case "group":
      return { type: "group", groupId: subject.id };
    case "role":
      return { type: "role", roleId: subject.id };
  }
}

function explainEntrySource(source: AccessEntrySource, userId: string): ExplainEntryOrigin {
  if (source.kind === "role_permission") return source;
  return {
    ...source,
    subject: explainGrantSubject(source.subject, userId),
  };
}

function roleIdForEntry(entry: RuntimeEntry) {
  if (entry.source?.kind === "role_permission" || entry.source?.kind === "resource_role") {
    return entry.source.roleId;
  }
  return undefined;
}

function compareGrantSources(a: ExplainGrantSource, b: ExplainGrantSource) {
  return a.grantId.localeCompare(b.grantId);
}

// Tenant-admin reads share the canonical permission gate with authorize(), so an
// in-app admin screen and a can() check resolve identically (wildcard,
// deny-override, owner-only levers). Returns false when not allowed, and the
// queries above then return an empty list.
async function callerHasTenantPermission(
  ctx: GenericQueryCtx<DataModel>,
  args: { tokenIdentifier?: string; tenantId: string },
  permission: string,
): Promise<boolean> {
  const decision = await evaluatePermissionDecision(ctx, {
    tokenIdentifier: args.tokenIdentifier,
    tenantId: args.tenantId,
    permission,
  });
  return decision.allowed;
}

async function resolveScopeRow(ctx: GenericQueryCtx<DataModel>, tenantId: string) {
  if (tenantId === DEFAULT_TENANT_SENTINEL) {
    return await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
  }
  return await ctx.db
    .query("scopes")
    .withIndex("by_scope_id", (q) => q.eq("accessScopeId", tenantId))
    .unique();
}

async function resolveDefaultUserPrincipal(ctx: GenericQueryCtx<DataModel>, authUserId: string) {
  const scopes = await ctx.db
    .query("scopes")
    .withIndex("by_kind", (q) => q.eq("kind", "default"))
    .collect();
  if (scopes.length !== 1) return null;
  const scope = scopes[0]!;

  const principals = await ctx.db
    .query("principals")
    .withIndex("by_scope_auth_user", (q) =>
      q.eq("accessScopeId", scope.accessScopeId).eq("herculesAuthUserId", authUserId),
    )
    .collect();
  if (principals.length !== 1) return null;

  const principal = principals[0]!;
  if (principal.type !== "user") return null;

  return { scope, principal };
}

function pageLimit(operation: string, limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${operation} limit must be an integer from 1 to 100`);
  }
  return value;
}

function syncFailed(
  reasonCode: string,
  currentSourceVersion: number | undefined,
  targetSourceVersion: number,
): TargetTenantSyncStatus {
  return {
    state: "failed",
    reasonCode,
    ...(currentSourceVersion === undefined ? {} : { currentSourceVersion }),
    targetSourceVersion,
  };
}

function isCompletedAccessDenial(reasonCode: string): boolean {
  return (
    reasonCode === "tenant_disabled" ||
    reasonCode === "principal_missing" ||
    reasonCode.startsWith("principal_") ||
    reasonCode === "app_principal_missing" ||
    reasonCode.startsWith("app_principal_")
  );
}

function publicTenantLifecycleStatus(
  status: "active" | "disabled",
): TenantDetail["lifecycleStatus"] {
  return status === "disabled" ? "archived" : "active";
}

type DirectResourceSubjectsCursor = {
  phase: "role_bindings" | "permission_bindings";
  cursor: string | null;
};

function parseDirectResourceSubjectsCursor(
  value: string | undefined,
): DirectResourceSubjectsCursor {
  if (value === undefined) {
    return { phase: "role_bindings", cursor: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("listDirectSubjectsForResource cursor is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("phase" in parsed) ||
    (parsed.phase !== "role_bindings" && parsed.phase !== "permission_bindings") ||
    !("cursor" in parsed) ||
    (parsed.cursor !== null && typeof parsed.cursor !== "string")
  ) {
    throw new Error("listDirectSubjectsForResource cursor is invalid");
  }
  return {
    phase: parsed.phase,
    cursor: parsed.cursor,
  };
}

function serializeDirectResourceSubjectsCursor(cursor: DirectResourceSubjectsCursor): string {
  return JSON.stringify(cursor);
}

function roleSummary(role: {
  roleId: string;
  key: string;
  name: string;
  source: "system" | "iam" | "tenant";
}): RoleSummary {
  return {
    roleId: role.roleId,
    roleKey: role.key,
    roleName: role.name,
    roleKind: roleKindFromSource(role.source),
  };
}

function tenantPermissionSummary(permission: {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
}): TenantPermissionSummary {
  return {
    permissionId: permission.permissionId,
    key: permission.key,
    resourceType: permission.resourceType,
    action: permission.action,
    classification: permission.classification,
    tenantAssignable: permission.tenantAssignable,
  };
}

async function tenantUserFromPrincipal(
  ctx: GenericQueryCtx<DataModel>,
  principal: {
    principalId: string;
    type: "user" | "group";
    herculesAuthUserId?: string;
    status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
    joinedAt: number;
  },
  scopeId: string,
): Promise<TenantUser | null> {
  if (principal.type !== "user" || !principal.herculesAuthUserId) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", principal.herculesAuthUserId!))
    .unique();
  const [roles, directRoleGrants] = await Promise.all([
    collectPrincipalScopeRoles(ctx, {
      principalId: principal.principalId,
      scopeId,
    }),
    collectPrincipalDirectScopeRoleGrants(ctx, {
      principalId: principal.principalId,
      scopeId,
    }),
  ]);
  return {
    userId: principal.herculesAuthUserId,
    status: principal.status,
    joinedAt: principal.joinedAt,
    ...(user ? { name: user.name, email: user.email } : {}),
    ...(user?.image === undefined ? {} : { image: user.image }),
    roles,
    directRoleGrants,
  };
}

async function tenantPickerUserFromPrincipal(
  ctx: GenericQueryCtx<DataModel>,
  principal: {
    type: "user" | "group";
    herculesAuthUserId?: string;
  },
): Promise<TenantMemberPickerUser | null> {
  if (principal.type !== "user" || !principal.herculesAuthUserId) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", principal.herculesAuthUserId!))
    .unique();
  if (!user) return null;
  return {
    userId: user.herculesAuthUserId,
    name: user.name,
    email: user.email,
    ...(user.image === undefined ? {} : { image: user.image }),
  };
}

async function sharingRecipientFromPrincipal(
  ctx: GenericQueryCtx<DataModel>,
  principal: {
    principalId: string;
    type: "user" | "group";
    herculesAuthUserId?: string;
    name?: string;
  },
): Promise<SharingRecipient | null> {
  if (principal.type === "group") {
    return {
      type: "group",
      groupId: principal.principalId,
      ...(principal.name === undefined ? {} : { name: principal.name }),
    };
  }

  const user = await tenantPickerUserFromPrincipal(ctx, principal);
  return user ? { type: "user", ...user } : null;
}

async function tenantGroupFromPrincipal(
  ctx: GenericQueryCtx<DataModel>,
  principal: {
    principalId: string;
    type: "user" | "group";
    name?: string;
    memberCount: number;
    status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
    joinedAt: number;
  },
  scopeId: string,
): Promise<TenantGroup> {
  const [roles, directRoleGrants] = await Promise.all([
    collectPrincipalScopeRoles(ctx, {
      principalId: principal.principalId,
      scopeId,
    }),
    collectPrincipalDirectScopeRoleGrants(ctx, {
      principalId: principal.principalId,
      scopeId,
    }),
  ]);
  return {
    groupId: principal.principalId,
    status: principal.status,
    joinedAt: principal.joinedAt,
    memberCount: principal.memberCount,
    ...(principal.name === undefined ? {} : { name: principal.name }),
    roles,
    directRoleGrants,
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
    roles.push(roleSummary(role));
  }

  roles.sort(
    (a, b) =>
      a.roleKey.localeCompare(b.roleKey) ||
      a.roleName.localeCompare(b.roleName) ||
      a.roleId.localeCompare(b.roleId),
  );
  return roles;
}

async function principalHasDirectImmutableOwnerRole(
  ctx: GenericQueryCtx<DataModel>,
  args: { principalId: string; scopeId: string },
): Promise<boolean> {
  const bindings = await ctx.db
    .query("role_bindings")
    .withIndex("by_subject_scope_resource", (q) =>
      q
        .eq("subjectPrincipalId", args.principalId)
        .eq("accessScopeId", args.scopeId)
        .eq("resourceType", undefined)
        .eq("resourceId", undefined),
    )
    .collect();
  const now = Date.now();
  for (const binding of bindings) {
    if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) continue;
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", binding.roleId))
      .unique();
    if (role?.source === "system" && role.key === "owner" && role.baseWildcard === "immutable") {
      return true;
    }
  }
  return false;
}

async function collectPrincipalDirectScopeRoleGrants(
  ctx: GenericQueryCtx<DataModel>,
  args: { principalId: string; scopeId: string },
): Promise<DirectRoleGrant[]> {
  const bindings = await ctx.db
    .query("role_bindings")
    .withIndex("by_subject_scope_resource", (q) =>
      q
        .eq("subjectPrincipalId", args.principalId)
        .eq("accessScopeId", args.scopeId)
        .eq("resourceType", undefined)
        .eq("resourceId", undefined),
    )
    .collect();

  const now = Date.now();
  const grants: DirectRoleGrant[] = [];
  for (const binding of bindings) {
    if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) continue;
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("roleId", binding.roleId))
      .unique();
    if (!role) continue;
    grants.push({
      grantId: binding.bindingId,
      type: "role",
      roleId: role.roleId,
      roleKey: role.key,
      roleName: role.name,
      roleKind: roleKindFromSource(role.source),
      expiresAt: binding.expiresAt ?? null,
    });
  }

  grants.sort(
    (a, b) =>
      a.roleKey.localeCompare(b.roleKey) ||
      a.roleName.localeCompare(b.roleName) ||
      a.grantId.localeCompare(b.grantId),
  );
  return grants;
}
