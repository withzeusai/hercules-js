import {
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import {
  accessProjectionSyncPayloadSchema,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
  type ProjectionResourceRoleAssignment,
  type ProjectionRoleAssignment,
} from "../shared/sync";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationCtx = GenericMutationCtx<DataModel>;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
// applySync is the parent-facing entry point (the app's HTTP sync route calls
// it via runMutation); it must be public-in-component to be exported.
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

// Exact-identity expiry mutations: scheduled at expiresAt so the reactive query
// is invalidated when a time-bound assignment lapses. The runtime check also
// fails closed on the timestamp, so a delayed schedule never over-grants.
const expireRoleAssignmentReference = makeFunctionReference<
  "mutation",
  { roleAssignmentId: string; expiresAt: number; updatedAt: number; sourceVersion: number }
>("sync:expireRoleAssignment");
const expireResourceRoleAssignmentReference = makeFunctionReference<
  "mutation",
  { resourceRoleAssignmentId: string; expiresAt: number; updatedAt: number; sourceVersion: number }
>("sync:expireResourceRoleAssignment");

// Convex transactions have document-count limits. Reject an oversized aggregate
// with a clear payload failure rather than letting the mutation abort opaquely.
const MAX_SNAPSHOT_DOCUMENTS = 16_000;

const MIRROR_TABLES = [
  "tenants",
  "roles",
  "permissions",
  "role_permissions",
  "resource_types",
  "memberships",
  "groups",
  "group_memberships",
  "role_assignments",
  "resource_role_assignments",
  "users",
] as const;
type MirrorTable = (typeof MIRROR_TABLES)[number];

// The args validator is intentionally loose (the producer ships either payload
// kind); real validation is the zod parse below.
const syncPayloadArgs = {
  type: v.union(v.literal("access.projection.snapshot"), v.literal("access.projection.event")),
  schemaVersion: v.number(),
  eventId: v.string(),
  sourceVersion: v.number(),
  mode: v.optional(v.union(v.literal("initialize"), v.literal("reset"))),
  expectedIssuer: v.optional(v.string()),
  changes: v.optional(v.array(v.any())),
  tenants: v.optional(v.array(v.any())),
  roles: v.optional(v.array(v.any())),
  permissions: v.optional(v.array(v.any())),
  rolePermissions: v.optional(v.array(v.any())),
  resourceTypes: v.optional(v.array(v.any())),
  memberships: v.optional(v.array(v.any())),
  groups: v.optional(v.array(v.any())),
  groupMemberships: v.optional(v.array(v.any())),
  roleAssignments: v.optional(v.array(v.any())),
  resourceRoleAssignments: v.optional(v.array(v.any())),
  users: v.optional(v.array(v.any())),
};

export const applySync = mutation({
  args: syncPayloadArgs,
  handler: async (ctx, rawArgs) => {
    if (rawArgs.schemaVersion !== 5) {
      return { ok: false as const, status: "unsupported_schema" as const };
    }

    const parsed = accessProjectionSyncPayloadSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    const payload = parsed.data;
    const state = await ctx.db.query("sync_state").unique();

    // Idempotency: a re-delivered event/snapshot with the same eventId is a
    // no-op ack (the version must match what we recorded for that eventId).
    if (state?.lastEventId === payload.eventId) {
      if (state.sourceVersion !== payload.sourceVersion) {
        return { ok: false as const, status: "invalid_payload" as const };
      }
      return {
        ok: true as const,
        status: "duplicate" as const,
        acknowledgedVersion: state.sourceVersion,
      };
    }

    if (payload.type === "access.projection.event") {
      if (!state) {
        return { ok: false as const, status: "not_ready" as const, currentVersion: 0 };
      }
      const expectedVersion = state.sourceVersion + 1;
      if (payload.sourceVersion !== expectedVersion) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion,
          receivedVersion: payload.sourceVersion,
        };
      }
    } else {
      if (payload.mode === "initialize" && state) {
        return {
          ok: false as const,
          status: "reset_required" as const,
          currentVersion: state.sourceVersion,
        };
      }
      if (payload.mode === "reset" && !state) {
        return { ok: false as const, status: "not_ready" as const, currentVersion: 0 };
      }
      if (state && state.expectedIssuer !== payload.expectedIssuer) {
        return { ok: false as const, status: "issuer_mismatch" as const };
      }
      if (payload.mode === "reset" && state && payload.sourceVersion < state.sourceVersion) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion: state.sourceVersion + 1,
          receivedVersion: payload.sourceVersion,
        };
      }
    }

    const sourceVersion = payload.sourceVersion;
    const now = Date.now();

    if (payload.type === "access.projection.snapshot") {
      if (snapshotDocumentCount(payload) > MAX_SNAPSHOT_DOCUMENTS) {
        return { ok: false as const, status: "invalid_payload" as const };
      }
      await replaceProjection(ctx, payload, sourceVersion, now);
    } else {
      await applyEvent(ctx, payload, sourceVersion, now);
    }

    const nextState = {
      sourceVersion,
      expectedIssuer:
        payload.type === "access.projection.snapshot"
          ? payload.expectedIssuer
          : state!.expectedIssuer,
      lastEventId: payload.eventId,
      lastSyncedAt: Date.now(),
    };
    if (state) {
      await ctx.db.replace(state._id, nextState);
    } else {
      await ctx.db.insert("sync_state", nextState);
    }

    return {
      ok: true as const,
      status: "applied" as const,
      acknowledgedVersion: sourceVersion,
    };
  },
});

// ── snapshot install (whole-aggregate, atomic) ───────────────────────────────
async function replaceProjection(
  ctx: MutationCtx,
  snapshot: AccessProjectionSnapshot,
  sourceVersion: number,
  now: number,
): Promise<void> {
  for (const table of MIRROR_TABLES) {
    await clearTable(ctx, table);
  }

  for (const row of snapshot.tenants) await ctx.db.insert("tenants", { ...row, sourceVersion });
  for (const row of snapshot.roles) await ctx.db.insert("roles", { ...row, sourceVersion });
  for (const row of snapshot.permissions)
    await ctx.db.insert("permissions", { ...row, sourceVersion });
  for (const row of snapshot.rolePermissions)
    await ctx.db.insert("role_permissions", { ...row, sourceVersion });
  for (const row of snapshot.resourceTypes)
    await ctx.db.insert("resource_types", { ...row, sourceVersion });
  for (const row of snapshot.memberships)
    await ctx.db.insert("memberships", { ...row, sourceVersion });
  for (const row of snapshot.groups) await ctx.db.insert("groups", { ...row, sourceVersion });
  for (const row of snapshot.groupMemberships)
    await ctx.db.insert("group_memberships", { ...row, sourceVersion });
  for (const row of snapshot.users) await ctx.db.insert("users", { ...row, sourceVersion });

  for (const assignment of snapshot.roleAssignments) {
    if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) continue;
    await ctx.db.insert("role_assignments", { ...assignment, sourceVersion });
    await scheduleRoleAssignmentExpiry(ctx, assignment, sourceVersion);
  }
  for (const assignment of snapshot.resourceRoleAssignments) {
    if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) continue;
    await ctx.db.insert("resource_role_assignments", { ...assignment, sourceVersion });
    await scheduleResourceRoleAssignmentExpiry(ctx, assignment, sourceVersion);
  }
}

// ── event application ────────────────────────────────────────────────────────
async function applyEvent(
  ctx: MutationCtx,
  event: AccessProjectionEvent,
  sourceVersion: number,
  now: number,
): Promise<void> {
  for (const change of event.changes) {
    if (change.operation === "delete") {
      await applyDelete(ctx, change);
      continue;
    }
    await applyUpsert(ctx, event, change, sourceVersion, now);
  }
}

async function applyUpsert(
  ctx: MutationCtx,
  event: AccessProjectionEvent,
  change: AccessProjectionEvent["changes"][number],
  sourceVersion: number,
  now: number,
): Promise<void> {
  switch (change.entityType) {
    case "tenant": {
      const row = event.tenants.find((r) => r.tenantId === change.tenantId);
      if (row) await upsertByIndex(ctx, "tenants", "by_tenant_id", "tenantId", row, sourceVersion);
      return;
    }
    case "role": {
      const row = event.roles.find((r) => r.roleId === change.roleId);
      if (row) await upsertByIndex(ctx, "roles", "by_role_id", "roleId", row, sourceVersion);
      return;
    }
    case "permission": {
      const row = event.permissions.find((r) => r.permissionId === change.permissionId);
      if (row)
        await upsertByIndex(
          ctx,
          "permissions",
          "by_permission_id",
          "permissionId",
          row,
          sourceVersion,
        );
      return;
    }
    case "role_permission": {
      const row = event.rolePermissions.find(
        (r) => r.roleId === change.roleId && r.permissionId === change.permissionId,
      );
      if (!row) return;
      const existing = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q.eq("roleId", row.roleId).eq("permissionId", row.permissionId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, { ...row, sourceVersion });
      else await ctx.db.insert("role_permissions", { ...row, sourceVersion });
      return;
    }
    case "resource_type": {
      const row = event.resourceTypes.find((r) => r.resourceTypeId === change.resourceTypeId);
      if (row)
        await upsertByIndex(
          ctx,
          "resource_types",
          "by_resource_type_id",
          "resourceTypeId",
          row,
          sourceVersion,
        );
      return;
    }
    case "membership": {
      const row = event.memberships.find((r) => r.membershipId === change.membershipId);
      if (row)
        await upsertByIndex(
          ctx,
          "memberships",
          "by_membership_id",
          "membershipId",
          row,
          sourceVersion,
        );
      return;
    }
    case "group": {
      const row = event.groups.find((r) => r.groupId === change.groupId);
      if (row) await upsertByIndex(ctx, "groups", "by_group_id", "groupId", row, sourceVersion);
      return;
    }
    case "group_membership": {
      const row = event.groupMemberships.find(
        (r) => r.groupId === change.groupId && r.membershipId === change.membershipId,
      );
      if (!row) return;
      const existing = await ctx.db
        .query("group_memberships")
        .withIndex("by_group_membership", (q) =>
          q.eq("groupId", row.groupId).eq("membershipId", row.membershipId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, { ...row, sourceVersion });
      else await ctx.db.insert("group_memberships", { ...row, sourceVersion });
      return;
    }
    case "role_assignment": {
      const row = event.roleAssignments.find((r) => r.roleAssignmentId === change.roleAssignmentId);
      if (row) await upsertRoleAssignment(ctx, row, sourceVersion, now);
      return;
    }
    case "resource_role_assignment": {
      const row = event.resourceRoleAssignments.find(
        (r) => r.resourceRoleAssignmentId === change.resourceRoleAssignmentId,
      );
      if (row) await upsertResourceRoleAssignment(ctx, row, sourceVersion, now);
      return;
    }
    case "user": {
      const row = event.users.find((r) => r.herculesAuthUserId === change.herculesAuthUserId);
      if (row)
        await upsertByIndex(
          ctx,
          "users",
          "by_auth_user_id",
          "herculesAuthUserId",
          row,
          sourceVersion,
        );
      return;
    }
  }
}

async function applyDelete(
  ctx: MutationCtx,
  change: AccessProjectionEvent["changes"][number],
): Promise<void> {
  switch (change.entityType) {
    case "tenant":
      return deleteTenant(ctx, change.tenantId);
    case "role":
      return deleteRole(ctx, change.roleId);
    case "permission":
      return deletePermission(ctx, change.permissionId);
    case "role_permission":
      return deleteRolePermission(ctx, change.roleId, change.permissionId);
    case "resource_type":
      return deleteResourceType(ctx, change.resourceTypeId);
    case "membership":
      return deleteMembership(ctx, change.membershipId);
    case "group":
      return deleteGroup(ctx, change.groupId);
    case "group_membership":
      return deleteGroupMembership(ctx, change.groupId, change.membershipId);
    case "role_assignment":
      return deleteByIndex(
        ctx,
        "role_assignments",
        "by_assignment_id",
        "roleAssignmentId",
        change.roleAssignmentId,
      );
    case "resource_role_assignment":
      return deleteByIndex(
        ctx,
        "resource_role_assignments",
        "by_assignment_id",
        "resourceRoleAssignmentId",
        change.resourceRoleAssignmentId,
      );
    case "user":
      return deleteByIndex(
        ctx,
        "users",
        "by_auth_user_id",
        "herculesAuthUserId",
        change.herculesAuthUserId,
      );
  }
}

// ── generic upsert/delete by a single-column identity index ───────────────────
// Dynamic table/index access defeats the per-table union types, so these
// plumbing helpers operate on a type-erased db handle. The zod parse upstream
// guarantees the row shapes match each table validator.
async function upsertByIndex(
  ctx: MutationCtx,
  table: MirrorTable,
  index: string,
  field: string,
  row: Record<string, unknown>,
  sourceVersion: number,
): Promise<void> {
  const db = ctx.db as any;
  const existing = await db
    .query(table)
    .withIndex(index, (q: any) => q.eq(field, row[field]))
    .unique();
  const next = { ...row, sourceVersion };
  if (existing) await db.replace(existing._id, next);
  else await db.insert(table, next);
}

async function deleteByIndex(
  ctx: MutationCtx,
  table: MirrorTable,
  index: string,
  field: string,
  value: string,
): Promise<void> {
  const db = ctx.db as any;
  const existing = await db
    .query(table)
    .withIndex(index, (q: any) => q.eq(field, value))
    .unique();
  if (existing) await db.delete(existing._id);
}

// ── time-bound assignment upserts (with expiry scheduling) ────────────────────
async function upsertRoleAssignment(
  ctx: MutationCtx,
  row: ProjectionRoleAssignment,
  sourceVersion: number,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("role_assignments")
    .withIndex("by_assignment_id", (q) => q.eq("roleAssignmentId", row.roleAssignmentId))
    .unique();
  if (row.expiresAt !== undefined && row.expiresAt <= now) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (existing) await ctx.db.replace(existing._id, { ...row, sourceVersion });
  else await ctx.db.insert("role_assignments", { ...row, sourceVersion });
  await scheduleRoleAssignmentExpiry(ctx, row, sourceVersion);
}

async function upsertResourceRoleAssignment(
  ctx: MutationCtx,
  row: ProjectionResourceRoleAssignment,
  sourceVersion: number,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("resource_role_assignments")
    .withIndex("by_assignment_id", (q) =>
      q.eq("resourceRoleAssignmentId", row.resourceRoleAssignmentId),
    )
    .unique();
  if (row.expiresAt !== undefined && row.expiresAt <= now) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (existing) await ctx.db.replace(existing._id, { ...row, sourceVersion });
  else await ctx.db.insert("resource_role_assignments", { ...row, sourceVersion });
  await scheduleResourceRoleAssignmentExpiry(ctx, row, sourceVersion);
}

async function scheduleRoleAssignmentExpiry(
  ctx: MutationCtx,
  row: ProjectionRoleAssignment,
  sourceVersion: number,
): Promise<void> {
  if (row.expiresAt === undefined) return;
  await ctx.scheduler.runAt(row.expiresAt, expireRoleAssignmentReference, {
    roleAssignmentId: row.roleAssignmentId,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    sourceVersion,
  });
}

async function scheduleResourceRoleAssignmentExpiry(
  ctx: MutationCtx,
  row: ProjectionResourceRoleAssignment,
  sourceVersion: number,
): Promise<void> {
  if (row.expiresAt === undefined) return;
  await ctx.scheduler.runAt(row.expiresAt, expireResourceRoleAssignmentReference, {
    resourceRoleAssignmentId: row.resourceRoleAssignmentId,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    sourceVersion,
  });
}

// ── cascade deletes (control plane emits only the parent delete) ──────────────
async function deleteTenant(ctx: MutationCtx, tenantId: string): Promise<void> {
  await deleteAllByIndex(ctx, "memberships", "by_tenant", (q) => q.eq("tenantId", tenantId));
  await deleteAllByIndex(ctx, "groups", "by_tenant", (q) => q.eq("tenantId", tenantId));
  await deleteAllByIndex(ctx, "group_memberships", "by_tenant", (q) => q.eq("tenantId", tenantId));
  await deleteAllByIndex(ctx, "role_assignments", "by_tenant", (q) => q.eq("tenantId", tenantId));
  await deleteAllByIndex(ctx, "resource_role_assignments", "by_tenant", (q) =>
    q.eq("tenantId", tenantId),
  );
  await deleteByIndex(ctx, "tenants", "by_tenant_id", "tenantId", tenantId);
}

async function deleteRole(ctx: MutationCtx, roleId: string): Promise<void> {
  await deleteAllByIndex(ctx, "role_permissions", "by_role", (q) => q.eq("roleId", roleId));
  await deleteAllByIndex(ctx, "role_assignments", "by_role", (q) => q.eq("roleId", roleId));
  await deleteAllByIndex(ctx, "resource_role_assignments", "by_role", (q) =>
    q.eq("roleId", roleId),
  );
  await deleteByIndex(ctx, "roles", "by_role_id", "roleId", roleId);
}

async function deletePermission(ctx: MutationCtx, permissionId: string): Promise<void> {
  await deleteAllByIndex(ctx, "role_permissions", "by_permission", (q) =>
    q.eq("permissionId", permissionId),
  );
  await deleteByIndex(ctx, "permissions", "by_permission_id", "permissionId", permissionId);
}

async function deleteResourceType(ctx: MutationCtx, resourceTypeId: string): Promise<void> {
  await deleteAllByIndex(ctx, "resource_role_assignments", "by_resource_type", (q) =>
    q.eq("resourceTypeId", resourceTypeId),
  );
  await deleteByIndex(
    ctx,
    "resource_types",
    "by_resource_type_id",
    "resourceTypeId",
    resourceTypeId,
  );
}

async function deleteMembership(ctx: MutationCtx, membershipId: string): Promise<void> {
  await deleteAllByIndex(ctx, "group_memberships", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteAllByIndex(ctx, "role_assignments", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteAllByIndex(ctx, "resource_role_assignments", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteByIndex(ctx, "memberships", "by_membership_id", "membershipId", membershipId);
}

async function deleteGroup(ctx: MutationCtx, groupId: string): Promise<void> {
  await deleteAllByIndex(ctx, "group_memberships", "by_group", (q) => q.eq("groupId", groupId));
  await deleteAllByIndex(ctx, "role_assignments", "by_group", (q) => q.eq("groupId", groupId));
  await deleteAllByIndex(ctx, "resource_role_assignments", "by_group", (q) =>
    q.eq("groupId", groupId),
  );
  await deleteByIndex(ctx, "groups", "by_group_id", "groupId", groupId);
}

async function deleteGroupMembership(
  ctx: MutationCtx,
  groupId: string,
  membershipId: string,
): Promise<void> {
  const existing = await ctx.db
    .query("group_memberships")
    .withIndex("by_group_membership", (q) =>
      q.eq("groupId", groupId).eq("membershipId", membershipId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

async function deleteRolePermission(
  ctx: MutationCtx,
  roleId: string,
  permissionId: string,
): Promise<void> {
  const existing = await ctx.db
    .query("role_permissions")
    .withIndex("by_role_permission", (q) => q.eq("roleId", roleId).eq("permissionId", permissionId))
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

async function deleteAllByIndex(
  ctx: MutationCtx,
  table: MirrorTable,
  index: string,
  range: (q: any) => any,
): Promise<void> {
  const db = ctx.db as any;
  for (const row of await db.query(table).withIndex(index, range).collect()) {
    await db.delete(row._id);
  }
}

async function clearTable(ctx: MutationCtx, table: MirrorTable): Promise<void> {
  for (const row of await ctx.db.query(table).collect()) {
    await ctx.db.delete(row._id);
  }
}

function snapshotDocumentCount(snapshot: AccessProjectionSnapshot): number {
  return (
    snapshot.tenants.length +
    snapshot.roles.length +
    snapshot.permissions.length +
    snapshot.rolePermissions.length +
    snapshot.resourceTypes.length +
    snapshot.memberships.length +
    snapshot.groups.length +
    snapshot.groupMemberships.length +
    snapshot.roleAssignments.length +
    snapshot.resourceRoleAssignments.length +
    snapshot.users.length
  );
}

export const expireRoleAssignment = internalMutation({
  args: {
    roleAssignmentId: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("role_assignments")
      .withIndex("by_assignment_id", (q) => q.eq("roleAssignmentId", args.roleAssignmentId))
      .unique();
    if (
      !row ||
      row.expiresAt !== args.expiresAt ||
      row.updatedAt !== args.updatedAt ||
      row.sourceVersion !== args.sourceVersion
    ) {
      return;
    }
    if (args.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(args.expiresAt, expireRoleAssignmentReference, args);
      return;
    }
    await ctx.db.delete(row._id);
  },
});

export const expireResourceRoleAssignment = internalMutation({
  args: {
    resourceRoleAssignmentId: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("resource_role_assignments")
      .withIndex("by_assignment_id", (q) =>
        q.eq("resourceRoleAssignmentId", args.resourceRoleAssignmentId),
      )
      .unique();
    if (
      !row ||
      row.expiresAt !== args.expiresAt ||
      row.updatedAt !== args.updatedAt ||
      row.sourceVersion !== args.sourceVersion
    ) {
      return;
    }
    if (args.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(args.expiresAt, expireResourceRoleAssignmentReference, args);
      return;
    }
    await ctx.db.delete(row._id);
  },
});
