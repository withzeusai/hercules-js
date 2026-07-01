import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { collectMembershipRoleIds, resolvePrimaryTenant, resolveTenantRow } from "./access";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type TenantRow = DataModel["tenants"]["document"];
type RoleRow = DataModel["roles"]["document"];
type MembershipRow = DataModel["tenant_memberships"]["document"];
type GroupRow = DataModel["groups"]["document"];

const query = queryGeneric as QueryBuilder<DataModel, "public">;

const PAGE_LIMIT = 100;
function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return PAGE_LIMIT;
  return Math.min(limit, PAGE_LIMIT);
}

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  isAppScope: boolean;
  // Tenant scope, read together with isAppScope:
  //   • tenantId = <id>                  → TENANT-SCOPED: usable only in that tenant.
  //   • tenantId = null, isAppScope=false → SHARED: usable in every tenant.
  //   • tenantId = null, isAppScope=true  → APP-SCOPED: app-wide authority.
  tenantId: string | null;
};

export type DirectRoleAssignment = RoleSummary & {
  assignmentId: string;
  expiresAt: number | null;
};

export type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

export type TenantSummariesPage = { tenants: TenantSummary[]; cursor?: string };

export type TenantDetail = {
  tenantId: string;
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
    roleId: role.id,
    roleKey: role.key,
    roleName: role.name,
    isAppScope: role.isAppScope,
    tenantId: role.tenantId,
  };
}

function lifecycleStatus(status: "active" | "disabled"): "active" | "archived" {
  return status === "disabled" ? "archived" : "active";
}

async function resolveRole(ctx: QueryCtx, roleId: string): Promise<RoleRow | null> {
  return await ctx.db
    .query("roles")
    .withIndex("by_role_id", (q) => q.eq("id", roleId))
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
          .query("user_role_assignments")
          .withIndex("by_membership", (q) => q.eq("membershipId", subject.membershipId))
          .collect()
      : await ctx.db
          .query("group_role_assignments")
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
      assignmentId: row.id,
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
    .withIndex("by_user_id", (q) => q.eq("id", membership.userId))
    .unique();
  return {
    userId: membership.userId,
    status: membership.status,
    ...(user?.name === undefined ? {} : { name: user.name }),
    ...(user?.email === undefined ? {} : { email: user.email }),
    ...(user?.image === undefined ? {} : { image: user.image }),
    roles: await membershipRoles(ctx, membership),
    directRoleAssignments: await directRoleAssignments(
      ctx,
      { membershipId: membership.id },
      membership.tenantId,
    ),
  };
}

async function tenantGroupFromRow(ctx: QueryCtx, group: GroupRow): Promise<TenantGroup> {
  const members = await ctx.db
    .query("group_memberships")
    .withIndex("by_group", (q) => q.eq("groupId", group.id))
    .collect();
  const direct = await directRoleAssignments(ctx, { groupId: group.id }, group.tenantId);
  return {
    groupId: group.id,
    name: group.name,
    status: group.status,
    memberCount: members.length,
    roles: direct.map((assignment) => ({
      roleId: assignment.roleId,
      roleKey: assignment.roleKey,
      roleName: assignment.roleName,
      isAppScope: assignment.isAppScope,
      tenantId: assignment.tenantId,
    })),
    directRoleAssignments: direct,
  };
}

// Structural admin-read gate: the caller must hold an ACTIVE membership in the
// resolved tenant. Returns the resolved tenant row when allowed, `null`
// otherwise. There is no permission catalog for admin reads.
async function gate(
  ctx: QueryCtx,
  args: { tokenIdentifier?: string; tenantId?: string },
): Promise<TenantRow | null> {
  if (!args.tokenIdentifier) return null;
  const state = await ctx.db.query("sync_state").unique();
  if (!state) return null;
  const token = parseTokenIdentifier(args.tokenIdentifier);
  if (!token || token.issuer !== state.expectedIssuer) return null;
  const tenant = await resolveTenantRow(ctx, args.tenantId);
  if (!tenant) return null;
  const membership = await ctx.db
    .query("tenant_memberships")
    .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenant.id).eq("userId", token.subject))
    .unique();
  if (!membership || membership.status !== "active") return null;
  return tenant;
}

// Structural gate for a primary-tenant-admin operation (e.g. listing EVERY
// tenant). The membership is checked against the deployment's PRIMARY tenant
// specifically and the caller-supplied tenant id is ignored: holding a
// membership in some non-primary tenant must never authorize a global,
// cross-tenant read. Returns the primary tenant row when allowed, `null`
// otherwise.
async function gatePrimaryTenant(
  ctx: QueryCtx,
  args: { tokenIdentifier?: string },
): Promise<TenantRow | null> {
  if (!args.tokenIdentifier) return null;
  const state = await ctx.db.query("sync_state").unique();
  if (!state) return null;
  const token = parseTokenIdentifier(args.tokenIdentifier);
  if (!token || token.issuer !== state.expectedIssuer) return null;
  const primary = await resolvePrimaryTenant(ctx);
  if (!primary) return null;
  const membership = await ctx.db
    .query("tenant_memberships")
    .withIndex("by_tenant_user", (q) => q.eq("tenantId", primary.id).eq("userId", token.subject))
    .unique();
  if (!membership || membership.status !== "active") return null;
  return primary;
}

// ── caller-centric reads (me.*) ───────────────────────────────────────────────
export const getTenantAccessStatus = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TenantAccessStatus> => {
    return getTenantAccessStatusInline(ctx, args.tokenIdentifier, args.tenantId);
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
      .query("tenant_memberships")
      .withIndex("by_user", (q) => q.eq("userId", token.subject))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const tenants = (
      await Promise.all(
        page.page.map(async (membership): Promise<TenantSummary | null> => {
          if (args.status === "active" && membership.status !== "active") return null;
          const tenant = await ctx.db
            .query("tenants")
            .withIndex("by_tenant_id", (q) => q.eq("id", membership.tenantId))
            .unique();
          if (!tenant) return null;
          if (args.status === "active" && tenant.status !== "active") return null;
          return {
            tenantId: tenant.id,
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
      .query("tenant_memberships")
      .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenant.id).eq("userId", token.subject))
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
        tenantId: tenant.id,
        membershipId: status.membershipId,
      };
    }
    if (status.kind === "principal") {
      return {
        state: "denied",
        reasonCode: `membership_${status.status}`,
        currentSourceVersion: state.sourceVersion,
        targetSourceVersion,
        ...(tenant ? { tenantId: tenant.id } : {}),
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
    .query("tenant_memberships")
    .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenant.id).eq("userId", token.subject))
    .unique();
  if (!membership) {
    return { kind: "fallback", reason: "membership_missing", stateVersion: state.sourceVersion };
  }
  return {
    kind: "principal",
    membershipId: membership.id,
    status: membership.status,
    stateVersion: state.sourceVersion,
  };
}

// ── tenant reads ──────────────────────────────────────────────────────────────
export const getTenant = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TenantDetail | null> => {
    const tenant = await gate(ctx, args);
    if (!tenant) return null;
    return {
      tenantId: tenant.id,
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
    // Listing every tenant is a primary-tenant-admin read. Gate on an active
    // membership in the PRIMARY tenant, ignoring any caller-supplied tenant id.
    const primary = await gatePrimaryTenant(ctx, args);
    if (!primary) return { tenants: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("tenants")
      .withIndex("by_tenant_id")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      tenants: page.page.map((tenant) => ({
        tenantId: tenant.id,
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
    const tenant = await gate(ctx, args);
    if (!tenant) return { users: [] };
    const tenantId = tenant.id;
    const limit = pageLimit(args.limit);
    const status = args.status ?? "all";
    const page =
      status === "all"
        ? await paginator(ctx.db, schema)
            .query("tenant_memberships")
            .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
            .paginate({ cursor: args.cursor ?? null, numItems: limit })
        : await paginator(ctx.db, schema)
            .query("tenant_memberships")
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
    const tenant = await gate(ctx, args);
    if (!tenant) return null;
    const membership = await ctx.db
      .query("tenant_memberships")
      .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenant.id).eq("userId", args.userId))
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
    const tenant = await gate(ctx, args);
    if (!tenant) return { groups: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("groups")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant.id))
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
    const tenant = await gate(ctx, args);
    if (!tenant) return null;
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("id", args.groupId))
      .unique();
    if (!group || group.tenantId !== tenant.id) return null;
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
    const tenant = await gate(ctx, args);
    if (!tenant) return { users: [] };
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("id", args.groupId))
      .unique();
    if (!group || group.tenantId !== tenant.id) return { users: [] };
    const limit = pageLimit(args.limit);
    const page = await paginator(ctx.db, schema)
      .query("group_memberships")
      .withIndex("by_group", (q) => q.eq("groupId", group.id))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const users = (
      await Promise.all(
        page.page.map(async (groupMembership) => {
          const membership = await ctx.db
            .query("tenant_memberships")
            .withIndex("by_membership_id", (q) => q.eq("id", groupMembership.membershipId))
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
    const tenant = await gate(ctx, args);
    if (!tenant) return [];
    // Roles usable in this tenant = the tenant's own TENANT-SCOPED roles plus
    // SHARED roles (tenantId null, isAppScope false). APP-SCOPED roles (tenantId
    // null, isAppScope true) are app-wide authority grantable only to
    // primary-tenant members, so they surface only for the primary tenant.
    const sharedRoles = await ctx.db
      .query("roles")
      .withIndex("by_tenant", (q) => q.eq("tenantId", null))
      .collect();
    const tenantRoles = await ctx.db
      .query("roles")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant.id))
      .collect();
    const visibleShared = tenant.isPrimaryTenant
      ? sharedRoles
      : sharedRoles.filter((role) => !role.isAppScope);
    return [...visibleShared, ...tenantRoles]
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
    const tenant = await gate(ctx, args);
    if (!tenant) return null;
    const role = await resolveRole(ctx, args.roleId);
    if (!role) return null;
    const rolePermissions = await ctx.db
      .query("role_permissions")
      .withIndex("by_role", (q) => q.eq("roleId", role.id))
      .collect();
    const permissionKeys: string[] = [];
    for (const rolePermission of rolePermissions) {
      const permission = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("id", rolePermission.permissionId))
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
