import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { collectMembershipRoleIds, resolveTenantRow } from "./access";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type RoleRow = DataModel["roles"]["document"];
type MembershipRow = DataModel["tenant_memberships"]["document"];

const query = queryGeneric as QueryBuilder<DataModel, "public">;

const PAGE_LIMIT = 100;
function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return PAGE_LIMIT;
  return Math.min(limit, PAGE_LIMIT);
}

// ── validators reused by the generic reads ────────────────────────────────────
const tenantStatusFilter = v.union(v.literal("active"), v.literal("disabled"));
const groupStatusFilter = v.union(v.literal("active"), v.literal("disabled"));
const membershipStatusFilter = v.union(
  v.literal("active"),
  v.literal("blocked"),
  v.literal("suspended"),
  v.literal("pending_approval"),
  v.literal("removed"),
);
const nullableString = v.union(v.string(), v.null());

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

export type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

// Caller-centric group summary (me.groups): the caller's own groups in a tenant.
export type GroupSummary = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
};

export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

export type TenantSummariesPage = { tenants: TenantSummary[]; cursor?: string };

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

// The caller's OWN groups in the resolved tenant. Gated like the other me.*
// reads: validate identity/issuer, require the caller's ACTIVE membership in the
// tenant, then return that membership's groups via group_memberships.
export const listMyGroups = query({
  args: { tokenIdentifier: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<GroupSummary[]> => {
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
    if (!membership || membership.status !== "active") return [];

    const groupMemberships = await ctx.db
      .query("group_memberships")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership.id))
      .collect();
    const groups: GroupSummary[] = [];
    for (const groupMembership of groupMemberships) {
      if (groupMembership.tenantId !== tenant.id) continue;
      const group = await ctx.db
        .query("groups")
        .withIndex("by_group_id", (q) => q.eq("id", groupMembership.groupId))
        .unique();
      if (group) groups.push({ groupId: group.id, name: group.name, status: group.status });
    }
    return groups.sort(
      (a, b) => a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId),
    );
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

// ── generic per-table reads (TRUSTED / UNGATED) ───────────────────────────────
//
// Plain ctx.db reads over the mirror tables: index-based scans plus unique-key
// lookups, with NO identity check and NO membership gate. The installing app is
// responsible for authorizing them (wrap the calling function in protectedQuery
// and/or call requirePermissions). Every returned record drops the Convex system
// fields (_id, _creationTime) and the internal sourceVersion bookkeeping.

type StripSystem<T> = Omit<T, "_id" | "_creationTime" | "sourceVersion">;

type SystemRow = { _id: unknown; _creationTime: number; sourceVersion: number };

export type TenantRecord = StripSystem<DataModel["tenants"]["document"]>;
export type UserRecord = StripSystem<DataModel["users"]["document"]>;
export type TenantMembershipRecord = StripSystem<DataModel["tenant_memberships"]["document"]>;
export type GroupRecord = StripSystem<DataModel["groups"]["document"]>;
export type GroupMembershipRecord = StripSystem<DataModel["group_memberships"]["document"]>;
export type RoleRecord = StripSystem<DataModel["roles"]["document"]>;
export type PermissionRecord = StripSystem<DataModel["permissions"]["document"]>;
export type RolePermissionRecord = StripSystem<DataModel["role_permissions"]["document"]>;
export type ResourceTypeRecord = StripSystem<DataModel["resource_types"]["document"]>;
export type UserRoleAssignmentRecord = StripSystem<DataModel["user_role_assignments"]["document"]>;
export type GroupRoleAssignmentRecord = StripSystem<
  DataModel["group_role_assignments"]["document"]
>;
export type UserResourceRoleAssignmentRecord = StripSystem<
  DataModel["user_resource_role_assignments"]["document"]
>;
export type GroupResourceRoleAssignmentRecord = StripSystem<
  DataModel["group_resource_role_assignments"]["document"]
>;

export type ItemsPage<V> = { items: V[]; cursor?: string };

// Drop Convex system fields + the internal sync version.
function record<Row extends SystemRow>(row: Row): StripSystem<Row> {
  const { _id, _creationTime, sourceVersion, ...rest } = row;
  return rest as StripSystem<Row>;
}

function got<Row extends SystemRow>(row: Row | null): StripSystem<Row> | null {
  return row ? record(row) : null;
}

// Paginate an index scan, drop system fields, and apply the (already
// index-narrowed) filters in JS. Like listMyTenants, a page may come back short
// after filtering; the cursor still advances the underlying index.
type PageableQuery<Row> = {
  paginate(opts: { cursor: string | null; numItems: number }): Promise<{
    page: Row[];
    isDone: boolean;
    continueCursor: string;
  }>;
};

async function paginate<Row extends SystemRow>(
  q: PageableQuery<Row>,
  args: { cursor?: string; limit?: number },
  predicate: (row: Row) => boolean,
): Promise<ItemsPage<StripSystem<Row>>> {
  const page = await q.paginate({ cursor: args.cursor ?? null, numItems: pageLimit(args.limit) });
  const items = page.page.filter(predicate).map(record);
  return { items, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
}

const pageArgs = { cursor: v.optional(v.string()), limit: v.optional(v.number()) };

// ── tenants ───────────────────────────────────────────────────────────────────
export const tenantsList = query({
  args: {
    status: v.optional(tenantStatusFilter),
    isPrimaryTenant: v.optional(v.boolean()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<TenantRecord>> => {
    const { status, isPrimaryTenant } = args;
    const base = paginator(ctx.db, schema).query("tenants");
    const q =
      isPrimaryTenant === undefined
        ? base.withIndex("by_tenant_id")
        : base.withIndex("by_primary", (i) => i.eq("isPrimaryTenant", isPrimaryTenant));
    return paginate(q, args, (row) => status === undefined || row.status === status);
  },
});

export const tenantsGet = query({
  args: { id: v.optional(v.string()), primary: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<TenantRecord | null> => {
    const { id, primary } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("tenants")
          .withIndex("by_tenant_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (primary) {
      return got(
        await ctx.db
          .query("tenants")
          .withIndex("by_primary", (q) => q.eq("isPrimaryTenant", true))
          .first(),
      );
    }
    return null;
  },
});

// ── users ─────────────────────────────────────────────────────────────────────
export const usersList = query({
  args: { email: v.optional(v.string()), ...pageArgs },
  handler: async (ctx, args): Promise<ItemsPage<UserRecord>> => {
    const { email } = args;
    const base = paginator(ctx.db, schema).query("users");
    const q =
      email === undefined
        ? base.withIndex("by_user_id")
        : base.withIndex("by_email", (i) => i.eq("email", email));
    return paginate(q, args, () => true);
  },
});

export const usersGet = query({
  args: { id: v.optional(v.string()), email: v.optional(v.string()) },
  handler: async (ctx, args): Promise<UserRecord | null> => {
    const { id, email } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("users")
          .withIndex("by_user_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (email !== undefined) {
      return got(
        await ctx.db
          .query("users")
          .withIndex("by_email", (q) => q.eq("email", email))
          .unique(),
      );
    }
    return null;
  },
});

// ── groups ────────────────────────────────────────────────────────────────────
export const groupsList = query({
  args: {
    tenantId: v.optional(v.string()),
    status: v.optional(groupStatusFilter),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<GroupRecord>> => {
    const { tenantId, status } = args;
    const base = paginator(ctx.db, schema).query("groups");
    const q =
      tenantId === undefined
        ? base.withIndex("by_group_id")
        : base.withIndex("by_tenant", (i) => i.eq("tenantId", tenantId));
    return paginate(q, args, (row) => status === undefined || row.status === status);
  },
});

export const groupsGet = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<GroupRecord | null> => {
    return got(
      await ctx.db
        .query("groups")
        .withIndex("by_group_id", (q) => q.eq("id", args.id))
        .unique(),
    );
  },
});

// ── roles ─────────────────────────────────────────────────────────────────────
export const rolesList = query({
  args: {
    tenantId: v.optional(nullableString),
    isAppScope: v.optional(v.boolean()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<RoleRecord>> => {
    const { tenantId, isAppScope } = args;
    const base = paginator(ctx.db, schema).query("roles");
    const q =
      tenantId === undefined
        ? base.withIndex("by_role_id")
        : base.withIndex("by_tenant", (i) => i.eq("tenantId", tenantId));
    return paginate(q, args, (row) => isAppScope === undefined || row.isAppScope === isAppScope);
  },
});

export const rolesGet = query({
  args: {
    id: v.optional(v.string()),
    key: v.optional(v.string()),
    tenantId: v.optional(nullableString),
  },
  handler: async (ctx, args): Promise<RoleRecord | null> => {
    const { id, key, tenantId } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("roles")
          .withIndex("by_role_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (key !== undefined) {
      // A role key is not globally unique (a tenant-scoped and a shared role can
      // share a key), so narrow by tenantId when supplied, else take the first.
      const rows = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", key))
        .collect();
      const match = tenantId !== undefined ? rows.find((r) => r.tenantId === tenantId) : rows[0];
      return match ? record(match) : null;
    }
    return null;
  },
});

// ── permissions ───────────────────────────────────────────────────────────────
export const permissionsList = query({
  args: { isAppScope: v.optional(v.boolean()), ...pageArgs },
  handler: async (ctx, args): Promise<ItemsPage<PermissionRecord>> => {
    const { isAppScope } = args;
    const q = paginator(ctx.db, schema).query("permissions").withIndex("by_permission_id");
    return paginate(q, args, (row) => isAppScope === undefined || row.isAppScope === isAppScope);
  },
});

export const permissionsGet = query({
  args: { id: v.optional(v.string()), key: v.optional(v.string()) },
  handler: async (ctx, args): Promise<PermissionRecord | null> => {
    const { id, key } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("permissions")
          .withIndex("by_permission_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (key !== undefined) {
      return got(
        await ctx.db
          .query("permissions")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      );
    }
    return null;
  },
});

// ── resource types ────────────────────────────────────────────────────────────
export const resourceTypesList = query({
  args: { parentResourceTypeId: v.optional(nullableString), ...pageArgs },
  handler: async (ctx, args): Promise<ItemsPage<ResourceTypeRecord>> => {
    const { parentResourceTypeId } = args;
    const q = paginator(ctx.db, schema).query("resource_types").withIndex("by_resource_type_id");
    return paginate(
      q,
      args,
      (row) =>
        parentResourceTypeId === undefined || row.parentResourceTypeId === parentResourceTypeId,
    );
  },
});

export const resourceTypesGet = query({
  args: { id: v.optional(v.string()), key: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResourceTypeRecord | null> => {
    const { id, key } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("resource_types")
          .withIndex("by_resource_type_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (key !== undefined) {
      return got(
        await ctx.db
          .query("resource_types")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      );
    }
    return null;
  },
});

// ── tenant memberships ────────────────────────────────────────────────────────
export const tenantMembershipsList = query({
  args: {
    tenantId: v.optional(v.string()),
    status: v.optional(membershipStatusFilter),
    userId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<TenantMembershipRecord>> => {
    const { tenantId, status, userId } = args;
    const base = paginator(ctx.db, schema).query("tenant_memberships");
    const q =
      tenantId !== undefined && status !== undefined
        ? base.withIndex("by_tenant_status", (i) => i.eq("tenantId", tenantId).eq("status", status))
        : tenantId !== undefined
          ? base.withIndex("by_tenant", (i) => i.eq("tenantId", tenantId))
          : userId !== undefined
            ? base.withIndex("by_user", (i) => i.eq("userId", userId))
            : base.withIndex("by_membership_id");
    return paginate(
      q,
      args,
      (row) =>
        (status === undefined || row.status === status) &&
        (userId === undefined || row.userId === userId) &&
        (tenantId === undefined || row.tenantId === tenantId),
    );
  },
});

export const tenantMembershipsGet = query({
  args: {
    id: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TenantMembershipRecord | null> => {
    const { id, tenantId, userId } = args;
    if (id !== undefined) {
      return got(
        await ctx.db
          .query("tenant_memberships")
          .withIndex("by_membership_id", (q) => q.eq("id", id))
          .unique(),
      );
    }
    if (tenantId !== undefined && userId !== undefined) {
      return got(
        await ctx.db
          .query("tenant_memberships")
          .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenantId).eq("userId", userId))
          .unique(),
      );
    }
    return null;
  },
});

// ── user role assignments ─────────────────────────────────────────────────────
export const userRoleAssignmentsList = query({
  args: {
    tenantId: v.optional(v.string()),
    membershipId: v.optional(v.string()),
    roleId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<UserRoleAssignmentRecord>> => {
    const { tenantId, membershipId, roleId } = args;
    const base = paginator(ctx.db, schema).query("user_role_assignments");
    const q =
      membershipId !== undefined
        ? base.withIndex("by_membership", (i) => i.eq("membershipId", membershipId))
        : roleId !== undefined
          ? base.withIndex("by_role_id", (i) => i.eq("roleId", roleId))
          : base.withIndex("by_assignment_id");
    return paginate(
      q,
      args,
      (row) =>
        (tenantId === undefined || row.tenantId === tenantId) &&
        (membershipId === undefined || row.membershipId === membershipId) &&
        (roleId === undefined || row.roleId === roleId),
    );
  },
});

export const userRoleAssignmentsGet = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<UserRoleAssignmentRecord | null> => {
    return got(
      await ctx.db
        .query("user_role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("id", args.id))
        .unique(),
    );
  },
});

// ── group role assignments ────────────────────────────────────────────────────
export const groupRoleAssignmentsList = query({
  args: {
    tenantId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    roleId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<GroupRoleAssignmentRecord>> => {
    const { tenantId, groupId, roleId } = args;
    const base = paginator(ctx.db, schema).query("group_role_assignments");
    const q =
      groupId !== undefined
        ? base.withIndex("by_group", (i) => i.eq("groupId", groupId))
        : roleId !== undefined
          ? base.withIndex("by_role_id", (i) => i.eq("roleId", roleId))
          : base.withIndex("by_assignment_id");
    return paginate(
      q,
      args,
      (row) =>
        (tenantId === undefined || row.tenantId === tenantId) &&
        (groupId === undefined || row.groupId === groupId) &&
        (roleId === undefined || row.roleId === roleId),
    );
  },
});

export const groupRoleAssignmentsGet = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<GroupRoleAssignmentRecord | null> => {
    return got(
      await ctx.db
        .query("group_role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("id", args.id))
        .unique(),
    );
  },
});

// ── user resource role assignments ────────────────────────────────────────────
export const userResourceRoleAssignmentsList = query({
  args: {
    tenantId: v.optional(v.string()),
    membershipId: v.optional(v.string()),
    roleId: v.optional(v.string()),
    resourceTypeId: v.optional(v.string()),
    externalId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<UserResourceRoleAssignmentRecord>> => {
    const { tenantId, membershipId, roleId, resourceTypeId, externalId } = args;
    const base = paginator(ctx.db, schema).query("user_resource_role_assignments");
    const q =
      membershipId !== undefined
        ? base.withIndex("by_membership", (i) => i.eq("membershipId", membershipId))
        : base.withIndex("by_assignment_id");
    return paginate(
      q,
      args,
      (row) =>
        (tenantId === undefined || row.tenantId === tenantId) &&
        (membershipId === undefined || row.membershipId === membershipId) &&
        (roleId === undefined || row.roleId === roleId) &&
        (resourceTypeId === undefined || row.resourceTypeId === resourceTypeId) &&
        (externalId === undefined || row.externalId === externalId),
    );
  },
});

export const userResourceRoleAssignmentsGet = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<UserResourceRoleAssignmentRecord | null> => {
    return got(
      await ctx.db
        .query("user_resource_role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("id", args.id))
        .unique(),
    );
  },
});

// ── group resource role assignments ───────────────────────────────────────────
export const groupResourceRoleAssignmentsList = query({
  args: {
    tenantId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    roleId: v.optional(v.string()),
    resourceTypeId: v.optional(v.string()),
    externalId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<GroupResourceRoleAssignmentRecord>> => {
    const { tenantId, groupId, roleId, resourceTypeId, externalId } = args;
    const base = paginator(ctx.db, schema).query("group_resource_role_assignments");
    const q =
      groupId !== undefined
        ? base.withIndex("by_group", (i) => i.eq("groupId", groupId))
        : base.withIndex("by_assignment_id");
    return paginate(
      q,
      args,
      (row) =>
        (tenantId === undefined || row.tenantId === tenantId) &&
        (groupId === undefined || row.groupId === groupId) &&
        (roleId === undefined || row.roleId === roleId) &&
        (resourceTypeId === undefined || row.resourceTypeId === resourceTypeId) &&
        (externalId === undefined || row.externalId === externalId),
    );
  },
});

export const groupResourceRoleAssignmentsGet = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<GroupResourceRoleAssignmentRecord | null> => {
    return got(
      await ctx.db
        .query("group_resource_role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("id", args.id))
        .unique(),
    );
  },
});

// ── group memberships ─────────────────────────────────────────────────────────
export const groupMembershipsList = query({
  args: {
    groupId: v.optional(v.string()),
    membershipId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<GroupMembershipRecord>> => {
    const { groupId, membershipId, tenantId } = args;
    const base = paginator(ctx.db, schema).query("group_memberships");
    // group_memberships has no own-id index; by_group with no range is the
    // full-table scan.
    const q =
      groupId !== undefined
        ? base.withIndex("by_group", (i) => i.eq("groupId", groupId))
        : membershipId !== undefined
          ? base.withIndex("by_membership", (i) => i.eq("membershipId", membershipId))
          : base.withIndex("by_group");
    return paginate(
      q,
      args,
      (row) =>
        (groupId === undefined || row.groupId === groupId) &&
        (membershipId === undefined || row.membershipId === membershipId) &&
        (tenantId === undefined || row.tenantId === tenantId),
    );
  },
});

export const groupMembershipsGet = query({
  args: { groupId: v.string(), membershipId: v.string() },
  handler: async (ctx, args): Promise<GroupMembershipRecord | null> => {
    return got(
      await ctx.db
        .query("group_memberships")
        .withIndex("by_group_membership", (q) =>
          q.eq("groupId", args.groupId).eq("membershipId", args.membershipId),
        )
        .unique(),
    );
  },
});

// ── role permissions ──────────────────────────────────────────────────────────
export const rolePermissionsList = query({
  args: {
    roleId: v.optional(v.string()),
    permissionId: v.optional(v.string()),
    ...pageArgs,
  },
  handler: async (ctx, args): Promise<ItemsPage<RolePermissionRecord>> => {
    const { roleId, permissionId } = args;
    const base = paginator(ctx.db, schema).query("role_permissions");
    // role_permissions has no own-id index; by_role with no range is the
    // full-table scan.
    const q =
      roleId !== undefined
        ? base.withIndex("by_role", (i) => i.eq("roleId", roleId))
        : base.withIndex("by_role");
    return paginate(
      q,
      args,
      (row) =>
        (roleId === undefined || row.roleId === roleId) &&
        (permissionId === undefined || row.permissionId === permissionId),
    );
  },
});

export const rolePermissionsGet = query({
  args: { roleId: v.string(), permissionId: v.string() },
  handler: async (ctx, args): Promise<RolePermissionRecord | null> => {
    return got(
      await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q.eq("roleId", args.roleId).eq("permissionId", args.permissionId),
        )
        .unique(),
    );
  },
});
