import {
  actionGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import {
  accessProjectionSyncPayloadSchema,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
  type AccessProjectionSyncPayload,
  type ProjectionGroupResourceRoleAssignment,
  type ProjectionGroupRoleAssignment,
  type ProjectionUserResourceRoleAssignment,
  type ProjectionUserRoleAssignment,
  type SyncResponse,
} from "../shared/sync";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationCtx = GenericMutationCtx<DataModel>;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
// applySync (below) is the SINGLE public, parent-facing entry point for the
// signed sync channel. The raw mirror apply (applyProjection) is an
// internalMutation, so nothing the parent app can reach writes the mirror
// without a verified control-plane signature.
const action = actionGeneric as ActionBuilder<DataModel, "public">;

// The signing secret is bound to THIS component (Convex isolates component env
// vars from the app), so verification cannot be bypassed by a caller supplying
// their own secret.
const SYNC_SECRET_ENV_VAR = "HERCULES_SYNC_SECRET";

type AssignmentSubject = "user" | "group";

// Reference to the component-internal mirror apply. Only the verifying action
// below invokes it; it is never exported in the component's public API.
const applyProjectionReference = makeFunctionReference<
  "mutation",
  AccessProjectionSyncPayload,
  SyncResponse
>("sync:applyProjection");

// Exact-identity expiry mutations: scheduled at expiresAt so the reactive query
// is invalidated when a time-bound assignment lapses. The runtime check also
// fails closed on the timestamp, so a delayed schedule never over-grants. The
// `subject` selects which split table (user_* vs group_*) the id lives in.
const expireRoleAssignmentReference = makeFunctionReference<
  "mutation",
  {
    id: string;
    subject: AssignmentSubject;
    expiresAt: number;
    updatedAt: number;
    sourceVersion: number;
  }
>("sync:expireRoleAssignment");
const expireResourceRoleAssignmentReference = makeFunctionReference<
  "mutation",
  {
    id: string;
    subject: AssignmentSubject;
    expiresAt: number;
    updatedAt: number;
    sourceVersion: number;
  }
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
  "tenant_memberships",
  "groups",
  "group_memberships",
  "user_role_assignments",
  "group_role_assignments",
  "user_resource_role_assignments",
  "group_resource_role_assignments",
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
  userRoleAssignments: v.optional(v.array(v.any())),
  groupRoleAssignments: v.optional(v.array(v.any())),
  userResourceRoleAssignments: v.optional(v.array(v.any())),
  groupResourceRoleAssignments: v.optional(v.array(v.any())),
  users: v.optional(v.array(v.any())),
};

// Verify the standardwebhooks signature, then translate the library outcome:
// `ok` carries the parsed payload; a WebhookVerificationError is a clean
// rejection; anything else (e.g. a crypto fault) propagates as a server error.
function verifyWebhookPayload(secret: string, rawBody: string, headers: Record<string, string>) {
  try {
    return { ok: true as const, payload: new Webhook(secret).verify(rawBody, headers) };
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return { ok: false as const };
    }
    throw error;
  }
}

// applySync — the ONLY public surface that can reach the mirror. The parent
// app's thin HTTP route forwards the raw request body and the three
// standardwebhooks headers here; this action verifies the signature against the
// component-bound secret BEFORE running any mutation, then delegates to the
// internal apply. A caller that has not presented a control-plane signature
// over the exact body cannot install roles/permissions/memberships/assignments.
export const applySync = action({
  args: {
    payload: v.string(),
    webhookId: v.string(),
    webhookTimestamp: v.string(),
    webhookSignature: v.string(),
  },
  handler: async (ctx, args): Promise<SyncResponse> => {
    const secret = process.env[SYNC_SECRET_ENV_VAR];
    if (!secret) {
      // The signing secret is not bound to the component. Fail closed: never
      // write unverified data. Surfaces as a 500 at the HTTP route.
      throw new Error(`${SYNC_SECRET_ENV_VAR} is not configured for the Hercules IAM component.`);
    }
    const verified = verifyWebhookPayload(secret, args.payload, {
      "webhook-id": args.webhookId,
      "webhook-timestamp": args.webhookTimestamp,
      "webhook-signature": args.webhookSignature,
    });
    if (!verified.ok) {
      return { ok: false as const, status: "invalid_signature" as const };
    }
    const parsed = accessProjectionSyncPayloadSchema.safeParse(verified.payload);
    if (!parsed.success) {
      return { ok: false as const, status: "invalid_payload" as const };
    }
    return await ctx.runMutation(applyProjectionReference, parsed.data);
  },
});

// applyProjection — the raw mirror apply. internalMutation, so it is NOT in the
// component's public API and is reachable only from the verifying action above.
export const applyProjection = internalMutation({
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

// ── wire-row → mirror-row mappers ─────────────────────────────────────────────
// Owning-entity wire rows carry their control-plane PK under a qualified name
// (tenantId/roleId/…); the mirror stores it as the self-id column `id`. These
// mappers rename that field and stamp the sourceVersion. Reference columns keep
// their qualified names, so they pass through unchanged.
function mapTenant(row: AccessProjectionSnapshot["tenants"][number], sourceVersion: number) {
  return {
    id: row.tenantId,
    name: row.name,
    isPrimaryTenant: row.isPrimaryTenant,
    status: row.status,
    accountEntryMode: row.accountEntryMode,
    defaultRoleId: row.defaultRoleId,
    updatedAt: row.updatedAt,
    sourceVersion,
  };
}

function mapRole(row: AccessProjectionSnapshot["roles"][number], sourceVersion: number) {
  return {
    id: row.roleId,
    key: row.key,
    name: row.name,
    description: row.description,
    tenantId: row.tenantId,
    isAppScope: row.isAppScope,
    updatedAt: row.updatedAt,
    sourceVersion,
  };
}

function mapPermission(
  row: AccessProjectionSnapshot["permissions"][number],
  sourceVersion: number,
) {
  return {
    id: row.permissionId,
    key: row.key,
    isAppScope: row.isAppScope,
    updatedAt: row.updatedAt,
    sourceVersion,
  };
}

function mapResourceType(
  row: AccessProjectionSnapshot["resourceTypes"][number],
  sourceVersion: number,
) {
  return {
    id: row.resourceTypeId,
    key: row.key,
    name: row.name,
    parentResourceTypeId: row.parentResourceTypeId,
    updatedAt: row.updatedAt,
    sourceVersion,
  };
}

function mapMembership(
  row: AccessProjectionSnapshot["memberships"][number],
  sourceVersion: number,
) {
  return {
    id: row.membershipId,
    tenantId: row.tenantId,
    userId: row.userId,
    status: row.status,
    updatedAt: row.updatedAt,
    sourceVersion,
  };
}

function mapGroup(row: AccessProjectionSnapshot["groups"][number], sourceVersion: number) {
  return {
    id: row.groupId,
    tenantId: row.tenantId,
    name: row.name,
    status: row.status,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.description === undefined ? {} : { description: row.description }),
  };
}

function mapUser(row: AccessProjectionSnapshot["users"][number], sourceVersion: number) {
  return {
    id: row.userId,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    phoneVerified: row.phoneVerified,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.image === undefined ? {} : { image: row.image }),
    ...(row.phone === undefined ? {} : { phone: row.phone }),
  };
}

function mapUserRoleAssignment(row: ProjectionUserRoleAssignment, sourceVersion: number) {
  return {
    id: row.userRoleAssignmentId,
    tenantId: row.tenantId,
    membershipId: row.membershipId,
    roleId: row.roleId,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

function mapGroupRoleAssignment(row: ProjectionGroupRoleAssignment, sourceVersion: number) {
  return {
    id: row.groupRoleAssignmentId,
    tenantId: row.tenantId,
    groupId: row.groupId,
    roleId: row.roleId,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

function mapUserResourceRoleAssignment(
  row: ProjectionUserResourceRoleAssignment,
  sourceVersion: number,
) {
  return {
    id: row.userResourceRoleAssignmentId,
    tenantId: row.tenantId,
    membershipId: row.membershipId,
    roleId: row.roleId,
    resourceTypeId: row.resourceTypeId,
    externalId: row.externalId,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

function mapGroupResourceRoleAssignment(
  row: ProjectionGroupResourceRoleAssignment,
  sourceVersion: number,
) {
  return {
    id: row.groupResourceRoleAssignmentId,
    tenantId: row.tenantId,
    groupId: row.groupId,
    roleId: row.roleId,
    resourceTypeId: row.resourceTypeId,
    externalId: row.externalId,
    updatedAt: row.updatedAt,
    sourceVersion,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

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

  for (const row of snapshot.tenants) await ctx.db.insert("tenants", mapTenant(row, sourceVersion));
  for (const row of snapshot.roles) await ctx.db.insert("roles", mapRole(row, sourceVersion));
  for (const row of snapshot.permissions)
    await ctx.db.insert("permissions", mapPermission(row, sourceVersion));
  for (const row of snapshot.rolePermissions)
    await ctx.db.insert("role_permissions", { ...row, sourceVersion });
  for (const row of snapshot.resourceTypes)
    await ctx.db.insert("resource_types", mapResourceType(row, sourceVersion));
  for (const row of snapshot.memberships)
    await ctx.db.insert("tenant_memberships", mapMembership(row, sourceVersion));
  for (const row of snapshot.groups) await ctx.db.insert("groups", mapGroup(row, sourceVersion));
  for (const row of snapshot.groupMemberships)
    await ctx.db.insert("group_memberships", { ...row, sourceVersion });
  for (const row of snapshot.users) await ctx.db.insert("users", mapUser(row, sourceVersion));

  for (const row of snapshot.userRoleAssignments) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    await ctx.db.insert("user_role_assignments", mapUserRoleAssignment(row, sourceVersion));
    await scheduleRoleAssignmentExpiry(
      ctx,
      "user",
      row.userRoleAssignmentId,
      row.expiresAt,
      row.updatedAt,
      sourceVersion,
    );
  }
  for (const row of snapshot.groupRoleAssignments) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    await ctx.db.insert("group_role_assignments", mapGroupRoleAssignment(row, sourceVersion));
    await scheduleRoleAssignmentExpiry(
      ctx,
      "group",
      row.groupRoleAssignmentId,
      row.expiresAt,
      row.updatedAt,
      sourceVersion,
    );
  }
  for (const row of snapshot.userResourceRoleAssignments) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    await ctx.db.insert(
      "user_resource_role_assignments",
      mapUserResourceRoleAssignment(row, sourceVersion),
    );
    await scheduleResourceRoleAssignmentExpiry(
      ctx,
      "user",
      row.userResourceRoleAssignmentId,
      row.expiresAt,
      row.updatedAt,
      sourceVersion,
    );
  }
  for (const row of snapshot.groupResourceRoleAssignments) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    await ctx.db.insert(
      "group_resource_role_assignments",
      mapGroupResourceRoleAssignment(row, sourceVersion),
    );
    await scheduleResourceRoleAssignmentExpiry(
      ctx,
      "group",
      row.groupResourceRoleAssignmentId,
      row.expiresAt,
      row.updatedAt,
      sourceVersion,
    );
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
      if (row) await upsertByIndex(ctx, "tenants", "by_tenant_id", mapTenant(row, sourceVersion));
      return;
    }
    case "role": {
      const row = event.roles.find((r) => r.roleId === change.roleId);
      if (row) await upsertByIndex(ctx, "roles", "by_role_id", mapRole(row, sourceVersion));
      return;
    }
    case "permission": {
      const row = event.permissions.find((r) => r.permissionId === change.permissionId);
      if (row)
        await upsertByIndex(
          ctx,
          "permissions",
          "by_permission_id",
          mapPermission(row, sourceVersion),
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
          mapResourceType(row, sourceVersion),
        );
      return;
    }
    case "membership": {
      const row = event.memberships.find((r) => r.membershipId === change.membershipId);
      if (row)
        await upsertByIndex(
          ctx,
          "tenant_memberships",
          "by_membership_id",
          mapMembership(row, sourceVersion),
        );
      return;
    }
    case "group": {
      const row = event.groups.find((r) => r.groupId === change.groupId);
      if (row) await upsertByIndex(ctx, "groups", "by_group_id", mapGroup(row, sourceVersion));
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
    case "user_role_assignment": {
      const row = event.userRoleAssignments.find(
        (r) => r.userRoleAssignmentId === change.userRoleAssignmentId,
      );
      if (row)
        await upsertAssignment(
          ctx,
          "user_role_assignments",
          "role",
          "user",
          row.userRoleAssignmentId,
          mapUserRoleAssignment(row, sourceVersion),
          row.expiresAt,
          row.updatedAt,
          sourceVersion,
          now,
        );
      return;
    }
    case "group_role_assignment": {
      const row = event.groupRoleAssignments.find(
        (r) => r.groupRoleAssignmentId === change.groupRoleAssignmentId,
      );
      if (row)
        await upsertAssignment(
          ctx,
          "group_role_assignments",
          "role",
          "group",
          row.groupRoleAssignmentId,
          mapGroupRoleAssignment(row, sourceVersion),
          row.expiresAt,
          row.updatedAt,
          sourceVersion,
          now,
        );
      return;
    }
    case "user_resource_role_assignment": {
      const row = event.userResourceRoleAssignments.find(
        (r) => r.userResourceRoleAssignmentId === change.userResourceRoleAssignmentId,
      );
      if (row)
        await upsertAssignment(
          ctx,
          "user_resource_role_assignments",
          "resource",
          "user",
          row.userResourceRoleAssignmentId,
          mapUserResourceRoleAssignment(row, sourceVersion),
          row.expiresAt,
          row.updatedAt,
          sourceVersion,
          now,
        );
      return;
    }
    case "group_resource_role_assignment": {
      const row = event.groupResourceRoleAssignments.find(
        (r) => r.groupResourceRoleAssignmentId === change.groupResourceRoleAssignmentId,
      );
      if (row)
        await upsertAssignment(
          ctx,
          "group_resource_role_assignments",
          "resource",
          "group",
          row.groupResourceRoleAssignmentId,
          mapGroupResourceRoleAssignment(row, sourceVersion),
          row.expiresAt,
          row.updatedAt,
          sourceVersion,
          now,
        );
      return;
    }
    case "user": {
      const row = event.users.find((r) => r.userId === change.userId);
      if (row) await upsertByIndex(ctx, "users", "by_user_id", mapUser(row, sourceVersion));
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
    case "user_role_assignment":
      return deleteByIndex(
        ctx,
        "user_role_assignments",
        "by_assignment_id",
        "id",
        change.userRoleAssignmentId,
      );
    case "group_role_assignment":
      return deleteByIndex(
        ctx,
        "group_role_assignments",
        "by_assignment_id",
        "id",
        change.groupRoleAssignmentId,
      );
    case "user_resource_role_assignment":
      return deleteByIndex(
        ctx,
        "user_resource_role_assignments",
        "by_assignment_id",
        "id",
        change.userResourceRoleAssignmentId,
      );
    case "group_resource_role_assignment":
      return deleteByIndex(
        ctx,
        "group_resource_role_assignments",
        "by_assignment_id",
        "id",
        change.groupResourceRoleAssignmentId,
      );
    case "user":
      return deleteByIndex(ctx, "users", "by_user_id", "id", change.userId);
  }
}

// ── generic upsert/delete by a single-column identity index ───────────────────
// Dynamic table/index access defeats the per-table union types, so these
// plumbing helpers operate on a type-erased db handle. The zod parse upstream
// and the mappers above guarantee the row shapes match each table validator.
// Owning-entity self-id lives in the `id` column (index by_<entity>_id on
// ["id"]), so the mapped row is queried by its own `id`.
async function upsertByIndex(
  ctx: MutationCtx,
  table: MirrorTable,
  index: string,
  row: { id: string } & Record<string, unknown>,
): Promise<void> {
  const db = ctx.db as any;
  const existing = await db
    .query(table)
    .withIndex(index, (q: any) => q.eq("id", row.id))
    .unique();
  if (existing) await db.replace(existing._id, row);
  else await db.insert(table, row);
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
// Assignment tables are split by subject, so the target table is chosen 1:1 by
// the change entityType; the mapped row already carries the self-id as `id`.
async function upsertAssignment(
  ctx: MutationCtx,
  table: MirrorTable,
  kind: "role" | "resource",
  subject: AssignmentSubject,
  id: string,
  row: { id: string } & Record<string, unknown>,
  expiresAt: number | undefined,
  updatedAt: number,
  sourceVersion: number,
  now: number,
): Promise<void> {
  const db = ctx.db as any;
  const existing = await db
    .query(table)
    .withIndex("by_assignment_id", (q: any) => q.eq("id", id))
    .unique();
  if (expiresAt !== undefined && expiresAt <= now) {
    if (existing) await db.delete(existing._id);
    return;
  }
  if (existing) await db.replace(existing._id, row);
  else await db.insert(table, row);
  if (kind === "role") {
    await scheduleRoleAssignmentExpiry(ctx, subject, id, expiresAt, updatedAt, sourceVersion);
  } else {
    await scheduleResourceRoleAssignmentExpiry(
      ctx,
      subject,
      id,
      expiresAt,
      updatedAt,
      sourceVersion,
    );
  }
}

async function scheduleRoleAssignmentExpiry(
  ctx: MutationCtx,
  subject: AssignmentSubject,
  id: string,
  expiresAt: number | undefined,
  updatedAt: number,
  sourceVersion: number,
): Promise<void> {
  if (expiresAt === undefined) return;
  await ctx.scheduler.runAt(expiresAt, expireRoleAssignmentReference, {
    id,
    subject,
    expiresAt,
    updatedAt,
    sourceVersion,
  });
}

async function scheduleResourceRoleAssignmentExpiry(
  ctx: MutationCtx,
  subject: AssignmentSubject,
  id: string,
  expiresAt: number | undefined,
  updatedAt: number,
  sourceVersion: number,
): Promise<void> {
  if (expiresAt === undefined) return;
  await ctx.scheduler.runAt(expiresAt, expireResourceRoleAssignmentReference, {
    id,
    subject,
    expiresAt,
    updatedAt,
    sourceVersion,
  });
}

// ── cascade deletes ───────────────────────────────────────────────────────────
// Only cascades backed by an index that EXISTS in the schema are performed here.
// Child rows with no supporting index (role_permissions by permissionId,
// resource-role assignments by roleId/resourceTypeId) are deleted by the control
// plane emitting their own delete changes BEFORE the parent delete.
async function deleteTenant(ctx: MutationCtx, tenantId: string): Promise<void> {
  const memberships = await ctx.db
    .query("tenant_memberships")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect();
  for (const membership of memberships) await deleteMembership(ctx, membership.id);
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect();
  for (const group of groups) await deleteGroup(ctx, group.id);
  await deleteByIndex(ctx, "tenants", "by_tenant_id", "id", tenantId);
}

async function deleteRole(ctx: MutationCtx, roleId: string): Promise<void> {
  await deleteAllByIndex(ctx, "role_permissions", "by_role", (q) => q.eq("roleId", roleId));
  await deleteAllByIndex(ctx, "user_role_assignments", "by_role_id", (q) => q.eq("roleId", roleId));
  await deleteAllByIndex(ctx, "group_role_assignments", "by_role_id", (q) =>
    q.eq("roleId", roleId),
  );
  await deleteByIndex(ctx, "roles", "by_role_id", "id", roleId);
}

async function deletePermission(ctx: MutationCtx, permissionId: string): Promise<void> {
  await deleteByIndex(ctx, "permissions", "by_permission_id", "id", permissionId);
}

async function deleteResourceType(ctx: MutationCtx, resourceTypeId: string): Promise<void> {
  await deleteByIndex(ctx, "resource_types", "by_resource_type_id", "id", resourceTypeId);
}

async function deleteMembership(ctx: MutationCtx, membershipId: string): Promise<void> {
  await deleteAllByIndex(ctx, "group_memberships", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteAllByIndex(ctx, "user_role_assignments", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteAllByIndex(ctx, "user_resource_role_assignments", "by_membership", (q) =>
    q.eq("membershipId", membershipId),
  );
  await deleteByIndex(ctx, "tenant_memberships", "by_membership_id", "id", membershipId);
}

async function deleteGroup(ctx: MutationCtx, groupId: string): Promise<void> {
  await deleteAllByIndex(ctx, "group_memberships", "by_group", (q) => q.eq("groupId", groupId));
  await deleteAllByIndex(ctx, "group_role_assignments", "by_group", (q) =>
    q.eq("groupId", groupId),
  );
  await deleteAllByIndex(ctx, "group_resource_role_assignments", "by_group", (q) =>
    q.eq("groupId", groupId),
  );
  await deleteByIndex(ctx, "groups", "by_group_id", "id", groupId);
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
    snapshot.userRoleAssignments.length +
    snapshot.groupRoleAssignments.length +
    snapshot.userResourceRoleAssignments.length +
    snapshot.groupResourceRoleAssignments.length +
    snapshot.users.length
  );
}

export const expireRoleAssignment = internalMutation({
  args: {
    id: v.string(),
    subject: v.union(v.literal("user"), v.literal("group")),
    expiresAt: v.number(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const table = args.subject === "user" ? "user_role_assignments" : "group_role_assignments";
    const db = ctx.db as any;
    const row = await db
      .query(table)
      .withIndex("by_assignment_id", (q: any) => q.eq("id", args.id))
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
    await db.delete(row._id);
  },
});

export const expireResourceRoleAssignment = internalMutation({
  args: {
    id: v.string(),
    subject: v.union(v.literal("user"), v.literal("group")),
    expiresAt: v.number(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const table =
      args.subject === "user"
        ? "user_resource_role_assignments"
        : "group_resource_role_assignments";
    const db = ctx.db as any;
    const row = await db
      .query(table)
      .withIndex("by_assignment_id", (q: any) => q.eq("id", args.id))
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
    await db.delete(row._id);
  },
});
