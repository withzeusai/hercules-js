import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import {
  collectMembershipRoleIds,
  evaluateAccess,
  resolvePrimaryTenant,
  resolveTenantRow,
} from "./access";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type RoleRow = DataModel["roles"]["document"];
type MembershipRow = DataModel["memberships"]["document"];
type GroupRow = DataModel["groups"]["document"];

const query = queryGeneric as QueryBuilder<DataModel, "public">;

const PAGE_LIMIT = 100;
function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return PAGE_LIMIT;
  return Math.min(limit, PAGE_LIMIT);
}

// Admin read permissions. Each mirrored admin read self-gates on the matching
// system read capability; the COMPONENT does authz, the server never will.
const PERMISSION_TENANTS_READ = "system.access.tenants:read";
const PERMISSION_USERS_READ = "system.access.users:read";
const PERMISSION_ROLES_READ = "system.access.roles:read";

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  isSystemRole: boolean;
  isRestricted: boolean;
};

export type DirectRoleAssignment = RoleSummary & {
  assignmentId: string;
  expiresAt: number | null;
};

export type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

export type TenantSummary = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

export type TenantSummariesPage = { tenants: TenantSummary[]; cursor?: string };

export type TenantDetail = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  lifecycleStatus: "active" | "archived";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

export type TenantDetailsPage = { tenants: TenantDetail[]; cursor?: string };

export type TenantUser = {
  userId: string;
  status: MembershipStatus;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

export type TenantGroup = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
  memberCount: number;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

export type TenantUsersPage = { users: TenantUser[]; cursor?: string };
export type TenantGroupsPage = { groups: TenantGroup[]; cursor?: string };

export type RoleDetail = RoleSummary & {
  description: string | null;
  permissionKeys: string[];
};

export type TenantAccessStatus =
  | { kind: "principal"; membershipId: string; status: MembershipStatus; stateVersion: number }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "tenant_missing"
        | "membership_missing";
      stateVersion?: number;
    };

export type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      membershipId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      membershipId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

function roleSummary(role: RoleRow): RoleSummary {
  return {
    roleId: role.roleId,
    roleKey: role.key,
    roleName: role.name,
    isSystemRole: role.source === "system",
    isRestricted: role.isRestricted,
  };
}

function lifecycleStatus(status: "active" | "disabled"): "active" | "archived" {
  return status === "disabled" ? "archived" : "active";
}

async function resolveRole(ctx: QueryCtx, roleId: string): Promise<RoleRow | null> {
  return await ctx.db
    .query("roles")
    .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
    .unique();
}

async function membershipRoles(ctx: QueryCtx, membership: MembershipRow): Promise<RoleSummary[]> {
  const roleIds = await collectMembershipRoleIds(ctx, membership, Date.now());
  const roles: RoleSummary[] = [];
  for (const roleId of roleIds) {
    const role = await resolveRole(ctx, roleId);
    if (role) roles.push(roleSummary(role));
  }
  return roles.sort((a, b) => a.roleKey.localeCompare(b.roleKey));
}

async function directRoleAssignments(
  ctx: QueryCtx,
  subject: { membershipId: string } | { groupId: string },
  tenantId: string,
): Promise<DirectRoleAssignment[]> {
  const rows =
    "membershipId" in subject
      ? await ctx.db
          .query("role_assignments")
          .withIndex("by_membership", (q) => q.eq("membershipId", subject.membershipId))
          .collect()
      : await ctx.db
          .query("role_assignments")
          .withIndex("by_group", (q) => q.eq("groupId", subject.groupId))
          .collect();
  const now = Date.now();
  const assignments: DirectRoleAssignment[] = [];
  for (const row of rows) {
    if (row.tenantId !== tenantId) continue;
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    const role = await resolveRole(ctx, row.roleId);
    if (!role) continue;
    assignments.push({
      ...roleSummary(role),
      assignmentId: row.roleAssignmentId,
      expiresAt: row.expiresAt ?? null,
    });
  }
  return assignments.sort((a, b) => a.roleKey.localeCompare(b.roleKey));
}

async function tenantUserFromMembership(
  ctx: QueryCtx,
  membership: MembershipRow,
): Promise<TenantUser> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", membership.herculesAuthUserId))
    .unique();
  return {
    userId: membership.herculesAuthUserId,
    status: membership.status,
    ...(user?.name === undefined ? {} : { name: user.name }),
    ...(user?.email === undefined ? {} : { email: user.email }),
    ...(user?.image === undefined ? {} : { image: user.image }),
    roles: await membershipRoles(ctx, membership),
    directRoleAssignments: await directRoleAssignments(
      ctx,
      { membershipId: membership.membershipId },
      membership.tenantId,
    ),
  };
}

async function tenantGroupFromRow(ctx: QueryCtx, group: GroupRow): Promise<TenantGroup> {
  const members = await ctx.db
    .query("group_memberships")
    .withIndex("by_group", (q) => q.eq("groupId", group.groupId))
    .collect();
  const direct = await directRoleAssignments(ctx, { groupId: group.groupId }, group.tenantId);
  return {
    groupId: group.groupId,
    name: group.name,
    status: group.status,
    memberCount: members.length,
    roles: direct.map((assignment) => ({
      roleId: assignment.roleId,
      roleKey: assignment.roleKey,
      roleName: assignment.roleName,
      isSystemRole: assignment.isSystemRole,
      isRestricted: assignment.isRestricted,
    })),
    directRoleAssignments: direct,
  };
}

// Gate an admin read on a system read capability, returning the resolved tenant
// id when allowed and `null` otherwise.
async function gate(
  ctx: QueryCtx,
  args: { tokenIdentifier?: string; tenantId?: string },
  permission: string,
): Promise<string | null> {
  const tenant = await resolveTenantRow(ctx, args.tenantId);
  if (!tenant) return null;
  const decision = await evaluateAccess(ctx, {
    ...(args.tokenIdentifier === undefined ? {} : { tokenIdentifier: args.tokenIdentifier }),
    tenantId: tenant.tenantId,
    permissionKey: permission,
  });
  return decision.allowed ? tenant.tenantId : null;
}

// Gate a primary-tenant-admin operation (e.g. listing EVERY tenant). The
// capability is checked against the deployment's PRIMARY tenant specifically and
// the caller-supplied tenant id is ignored: holding the permission in some
// non-primary tenant must never authorize a global, cross-tenant read.
// `system.access.tenants:read` is a restricted system permission, so only a
// primary-tenant admin can hold it there. Returns the primary tenant id when
// allowed, `null` otherwise.
async function gatePrimaryTenant(
  ctx: QueryCtx,
  args: { tokenIdentifier?: string },
  permission: string,
): Promise<string | null> {
  const primary = await resolvePrimaryTenant(ctx);
  if (!primary) return null;
  const decision = await evaluateAccess(ctx, {
    ...(args.tokenIdentifier === undefined ? {} : { tokenIdentifier: args.tokenIdentifier }),
    tenantId: primary.tenantId,
    permissionKey: permission,
  });
  return decision.allowed ? primary.tenantId : null;
}

// ── caller-centric reads (me.*) ───────────────────────────────────────────────
export const getTenantAccessStatus = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TenantAccessStatus> => {
    if (!args.tokenIdentifier) {
      return { kind: "fallback", reason: "identity_missing" };
    }
    const state = await ctx.db.query("sync_state").unique();
    if (!state) return { kind: "fallback", reason: "mirror_not_ready" };
    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token) {
      return { kind: "fallback", reason: "identity_invalid", stateVersion: state.sourceVersion };
    }
    if (token.issuer !== state.expectedIssuer) {
      return { kind: "fallback", reason: "unexpected_issuer", stateVersion: state.sourceVersion };
    }
    const tenant = await resolveTenantRow(ctx, args.tenantId);
    if (!tenant) {
      return { kind: "fallback", reason: "tenant_missing", stateVersion: state.sourceVersion };
    }
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_tenant_user", (q) =>
        q.eq("tenantId", tenant.tenantId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!membership) {
      return { kind: "fallback", reason: "membership_missing", stateVersion: state.sourceVersion };
    }
    return {
      kind: "principal",
      membershipId: membership.membershipId,
      status: membership.status,
      stateVersion: state.sourceVersion,
    };
  },
});

export const listMyTenants = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    status: v.optional(v.union(v.literal("active"), v.literal("all"))),
  },
  handler: async (ctx, args): Promise<TenantSummariesPage> => {
    if (!args.tokenIdentifier) return { tenants: [] };
    const state = await ctx.db.query("sync_state").unique();
    if (!state) return { tenants: [] };
    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return { tenants: [] };

    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("memberships")
      .withIndex("by_auth_user", (q) => q.eq("herculesAuthUserId", token.subject))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const tenants = (
      await Promise.all(
        page.page.map(async (membership): Promise<TenantSummary | null> => {
          if (args.status === "active" && membership.status !== "active") return null;
          const tenant = await ctx.db
            .query("tenants")
            .withIndex("by_tenant_id", (q) => q.eq("tenantId", membership.tenantId))
            .unique();
          if (!tenant) return null;
          if (args.status === "active" && tenant.status !== "active") return null;
          return {
            tenantId: tenant.tenantId,
            herculesAuthTenantId: tenant.herculesAuthTenantId,
            tenantName: tenant.name,
            isPrimaryTenant: tenant.isPrimaryTenant,
            accessStatus: membership.status,
            lifecycleStatus: lifecycleStatus(tenant.status),
            roles: await membershipRoles(ctx, membership),
          };
        }),
      )
    ).filter((tenant): tenant is TenantSummary => tenant !== null);

    return { tenants, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
  },
});

export const listMyRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<RoleSummary[]> => {
    if (!args.tokenIdentifier) return [];
    const state = await ctx.db.query("sync_state").unique();
    if (!state) return [];
    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token || token.issuer !== state.expectedIssuer) return [];
    const tenant = await resolveTenantRow(ctx, args.tenantId);
    if (!tenant) return [];
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_tenant_user", (q) =>
        q.eq("tenantId", tenant.tenantId).eq("herculesAuthUserId", token.subject),
      )
      .unique();
    if (!membership) return [];
    return membershipRoles(ctx, membership);
  },
});

export const getTargetTenantSyncStatus = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args): Promise<TargetTenantSyncStatus> => {
    const targetSourceVersion = args.sourceVersion;
    const state = await ctx.db.query("sync_state").unique();
    if (!state) return { state: "syncing", targetSourceVersion };
    if (state.sourceVersion < targetSourceVersion) {
      return {
        state: "syncing",
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
      };
    }
    const tenant = await resolveTenantRow(ctx, args.tenantId);
    const status = await getTenantAccessStatusInline(ctx, args.tokenIdentifier, args.tenantId);
    if (status.kind === "principal" && status.status === "active" && tenant) {
      return {
        state: "ready",
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
        tenantId: tenant.tenantId,
        membershipId: status.membershipId,
      };
    }
    if (status.kind === "principal") {
      return {
        state: "denied",
        reasonCode: `membership_${status.status}`,
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
        ...(tenant ? { tenantId: tenant.tenantId } : {}),
        membershipId: status.membershipId,
      };
    }
    return {
      state: "failed",
      reasonCode: status.reason,
      currentSourceVersion: state.sourceVersion,
      targetSourceVersion,
    };
  },
});

// Reusable form of getTenantAccessStatus for internal composition.
async function getTenantAccessStatusInline(
  ctx: QueryCtx,
  tokenIdentifier: string | undefined,
  tenantId: string | undefined,
): Promise<TenantAccessStatus> {
  if (!tokenIdentifier) return { kind: "fallback", reason: "identity_missing" };
  const state = await ctx.db.query("sync_state").unique();
  if (!state) return { kind: "fallback", reason: "mirror_not_ready" };
  const token = parseTokenIdentifier(tokenIdentifier);
  if (!token) {
    return { kind: "fallback", reason: "identity_invalid", stateVersion: state.sourceVersion };
  }
  if (token.issuer !== state.expectedIssuer) {
    return { kind: "fallback", reason: "unexpected_issuer", stateVersion: state.sourceVersion };
  }
  const tenant = await resolveTenantRow(ctx, tenantId);
  if (!tenant) {
    return { kind: "fallback", reason: "tenant_missing", stateVersion: state.sourceVersion };
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_tenant_user", (q) =>
      q.eq("tenantId", tenant.tenantId).eq("herculesAuthUserId", token.subject),
    )
    .unique();
  if (!membership) {
    return { kind: "fallback", reason: "membership_missing", stateVersion: state.sourceVersion };
  }
  return {
    kind: "principal",
    membershipId: membership.membershipId,
    status: membership.status,
    stateVersion: state.sourceVersion,
  };
}

// ── tenant reads ──────────────────────────────────────────────────────────────
export const getTenant = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TenantDetail | null> => {
    const tenantId = await gate(ctx, args, PERMISSION_TENANTS_READ);
    if (!tenantId) return null;
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_tenant_id", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (!tenant) return null;
    return {
      tenantId: tenant.tenantId,
      herculesAuthTenantId: tenant.herculesAuthTenantId,
      tenantName: tenant.name,
      isPrimaryTenant: tenant.isPrimaryTenant,
      lifecycleStatus: lifecycleStatus(tenant.status),
      accountEntryMode: tenant.accountEntryMode,
      defaultRoleId: tenant.defaultRoleId,
      updatedAt: tenant.updatedAt,
    };
  },
});

export const listTenants = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantDetailsPage> => {
    // Listing every tenant is a primary-tenant-admin read. Gate against the
    // PRIMARY tenant's tenants:read capability, ignoring any caller-supplied
    // tenant id — otherwise a caller holding tenants:read in a non-primary
    // tenant could pass that tenant id and enumerate all tenants.
    const primaryTenantId = await gatePrimaryTenant(ctx, args, PERMISSION_TENANTS_READ);
    if (!primaryTenantId) return { tenants: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("tenants")
      .withIndex("by_tenant_id")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      tenants: page.page.map((tenant) => ({
        tenantId: tenant.tenantId,
        herculesAuthTenantId: tenant.herculesAuthTenantId,
        tenantName: tenant.name,
        isPrimaryTenant: tenant.isPrimaryTenant,
        lifecycleStatus: lifecycleStatus(tenant.status),
        accountEntryMode: tenant.accountEntryMode,
        defaultRoleId: tenant.defaultRoleId,
        updatedAt: tenant.updatedAt,
      })),
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

// ── user reads ────────────────────────────────────────────────────────────────
export const listTenantUsers = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("blocked"),
        v.literal("suspended"),
        v.literal("pending_approval"),
        v.literal("removed"),
        v.literal("all"),
      ),
    ),
  },
  handler: async (ctx, args): Promise<TenantUsersPage> => {
    const tenantId = await gate(ctx, args, PERMISSION_USERS_READ);
    if (!tenantId) return { users: [] };
    const limit = pageLimit(args.limit);
    const status = args.status ?? "all";
    const page =
      status === "all"
        ? await paginator(ctx.db, schema)
            .query("memberships")
            .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
            .paginate({ cursor: args.cursor ?? null, numItems: limit })
        : await paginator(ctx.db, schema)
            .query("memberships")
            .withIndex("by_tenant_status", (q) => q.eq("tenantId", tenantId).eq("status", status))
            .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const users = await Promise.all(
      page.page.map((membership) => tenantUserFromMembership(ctx, membership)),
    );
    return { users, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
  },
});

export const getTenantUser = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<TenantUser | null> => {
    const tenantId = await gate(ctx, args, PERMISSION_USERS_READ);
    if (!tenantId) return null;
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_tenant_user", (q) =>
        q.eq("tenantId", tenantId).eq("herculesAuthUserId", args.userId),
      )
      .unique();
    if (!membership) return null;
    return tenantUserFromMembership(ctx, membership);
  },
});

// ── group reads ───────────────────────────────────────────────────────────────
export const listTenantGroups = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantGroupsPage> => {
    const tenantId = await gate(ctx, args, PERMISSION_USERS_READ);
    if (!tenantId) return { groups: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("groups")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const groups = await Promise.all(page.page.map((group) => tenantGroupFromRow(ctx, group)));
    return { groups, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
  },
});

export const getTenantGroup = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    groupId: v.string(),
  },
  handler: async (ctx, args): Promise<TenantGroup | null> => {
    const tenantId = await gate(ctx, args, PERMISSION_USERS_READ);
    if (!tenantId) return null;
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("groupId", args.groupId))
      .unique();
    if (!group || group.tenantId !== tenantId) return null;
    return tenantGroupFromRow(ctx, group);
  },
});

export const listGroupMembers = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    groupId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TenantUsersPage> => {
    const tenantId = await gate(ctx, args, PERMISSION_USERS_READ);
    if (!tenantId) return { users: [] };
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("groupId", args.groupId))
      .unique();
    if (!group || group.tenantId !== tenantId) return { users: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("group_memberships")
      .withIndex("by_group", (q) => q.eq("groupId", group.groupId))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const users = (
      await Promise.all(
        page.page.map(async (groupMembership) => {
          const membership = await ctx.db
            .query("memberships")
            .withIndex("by_membership_id", (q) =>
              q.eq("membershipId", groupMembership.membershipId),
            )
            .unique();
          return membership ? tenantUserFromMembership(ctx, membership) : null;
        }),
      )
    ).filter((user): user is TenantUser => user !== null);
    return { users, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
  },
});

// ── role catalog reads ────────────────────────────────────────────────────────
export const listTenantRoles = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<RoleSummary[]> => {
    const tenantId = await gate(ctx, args, PERMISSION_ROLES_READ);
    if (!tenantId) return [];
    const roles = await ctx.db.query("roles").collect();
    return roles
      .map(roleSummary)
      .sort((a, b) => a.roleKey.localeCompare(b.roleKey) || a.roleId.localeCompare(b.roleId));
  },
});

export const getTenantRole = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    roleId: v.string(),
  },
  handler: async (ctx, args): Promise<RoleDetail | null> => {
    const tenantId = await gate(ctx, args, PERMISSION_ROLES_READ);
    if (!tenantId) return null;
    const role = await resolveRole(ctx, args.roleId);
    if (!role) return null;
    const rolePermissions = await ctx.db
      .query("role_permissions")
      .withIndex("by_role", (q) => q.eq("roleId", role.roleId))
      .collect();
    const permissionKeys: string[] = [];
    for (const rolePermission of rolePermissions) {
      const permission = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", rolePermission.permissionId))
        .unique();
      if (permission) permissionKeys.push(permission.key);
    }
    permissionKeys.sort();
    return {
      ...roleSummary(role),
      description: role.description,
      permissionKeys,
    };
  },
});
