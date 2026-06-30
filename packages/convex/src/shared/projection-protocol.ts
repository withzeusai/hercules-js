// Hercules IAM projection wire protocol — v5 (schemaVersion 5).
//
// CONSUMER side. This module mirrors, as zod schemas, the producer-side source of
// truth on the Hercules control plane. Shared golden fixtures prove the two agree.
//
// The model is a flat ReBAC projection. There is no per-scope nesting, no catalog
// block, no wildcards, no effects, and no permission bindings. Every entity is a
// row in one of eleven top-level arrays. Two payload kinds:
//   • snapshot — bootstrap ("initialize") or destructive rebuild ("reset"). ONE
//     aggregate, applied atomically.
//   • event — normal delivery. A stored, complete, valid delta at an exact
//     sourceVersion. Each `upsert` change ships exactly one row in its entity
//     array; each `delete` change ships none.
import { z } from "zod";

// ── leaf enums ────────────────────────────────────────────────────────────────
export const accessProjectionSourceSchema = z.enum(["system", "iam"]);
export type AccessProjectionSource = z.infer<typeof accessProjectionSourceSchema>;

// Roles add a runtime-created `custom` source (system/iam stay platform/catalog).
export const accessProjectionRoleSourceSchema = z.enum(["system", "iam", "custom"]);
export type AccessProjectionRoleSource = z.infer<typeof accessProjectionRoleSourceSchema>;

export const accessProjectionTenantStatusSchema = z.enum(["active", "disabled"]);
export type AccessProjectionTenantStatus = z.infer<typeof accessProjectionTenantStatusSchema>;

export const accessProjectionGroupStatusSchema = z.enum(["active", "disabled"]);
export type AccessProjectionGroupStatus = z.infer<typeof accessProjectionGroupStatusSchema>;

export const accessProjectionAccountEntryModeSchema = z.enum([
  "open",
  "allowlisted_only",
  "invite_only",
  "approval_required",
]);
export type AccessProjectionAccountEntryMode = z.infer<
  typeof accessProjectionAccountEntryModeSchema
>;

// "blocked" and "pending_approval" are POLICY states (admission reconciliation
// may move memberships among active/pending_approval/blocked). "suspended" and
// "removed" are MANUAL states (admin suspension/eviction) that reconciliation
// must never touch.
export const accessProjectionMembershipStatusSchema = z.enum([
  "active",
  "blocked",
  "suspended",
  "pending_approval",
  "removed",
]);
export type AccessProjectionMembershipStatus = z.infer<
  typeof accessProjectionMembershipStatusSchema
>;

export const accessProjectionSubjectTypeSchema = z.enum(["user", "group"]);
export type AccessProjectionSubjectType = z.infer<typeof accessProjectionSubjectTypeSchema>;

// ── entity rows ─────────────────────────────────────────────────────────────
export const projectionTenantSchema = z.strictObject({
  tenantId: z.string().min(1),
  herculesAuthTenantId: z.string().min(1),
  name: z.string().min(1),
  isPrimaryTenant: z.boolean(),
  status: accessProjectionTenantStatusSchema,
  accountEntryMode: accessProjectionAccountEntryModeSchema,
  defaultRoleId: z.string().min(1).nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionTenant = z.infer<typeof projectionTenantSchema>;

export const projectionRoleSchema = z.strictObject({
  roleId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Tenant scope: null = SHARED (available in every tenant); a tenant id = the
  // OWNING tenant of a tenant-scoped role. Required (always present) at v5.
  tenantId: z.string().min(1).nullable(),
  source: accessProjectionRoleSourceSchema,
  isRestricted: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionRole = z.infer<typeof projectionRoleSchema>;

export const projectionPermissionSchema = z.strictObject({
  permissionId: z.string().min(1),
  key: z.string().min(1),
  resourceType: z.string().min(1),
  action: z.string().min(1),
  source: accessProjectionSourceSchema,
  isRestricted: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionPermission = z.infer<typeof projectionPermissionSchema>;

// Identity is (roleId, permissionId). No effect — this is an allow-only model.
export const projectionRolePermissionSchema = z.strictObject({
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionRolePermission = z.infer<typeof projectionRolePermissionSchema>;

export const projectionResourceTypeSchema = z.strictObject({
  resourceTypeId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  parentResourceTypeId: z.string().min(1).nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionResourceType = z.infer<typeof projectionResourceTypeSchema>;

export const projectionMembershipSchema = z.strictObject({
  membershipId: z.string().min(1),
  tenantId: z.string().min(1),
  herculesAuthUserId: z.string().min(1),
  status: accessProjectionMembershipStatusSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionMembership = z.infer<typeof projectionMembershipSchema>;

export const projectionGroupSchema = z.strictObject({
  groupId: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  status: accessProjectionGroupStatusSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionGroup = z.infer<typeof projectionGroupSchema>;

// Identity is (groupId, membershipId). Active memberships only are projected.
export const projectionGroupMembershipSchema = z.strictObject({
  groupId: z.string().min(1),
  membershipId: z.string().min(1),
  tenantId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionGroupMembership = z.infer<typeof projectionGroupMembershipSchema>;

// Tenant-wide role assignment. Exactly one subject: a user subject carries
// membershipId (and no groupId); a group subject carries groupId (and no
// membershipId).
function assertExactlyOneAssignmentSubject(
  assignment: { subjectType: AccessProjectionSubjectType; membershipId?: string; groupId?: string },
  ctx: z.RefinementCtx,
): void {
  if (assignment.subjectType === "user") {
    if (assignment.membershipId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["membershipId"],
        message: "A user subject assignment requires a membershipId",
      });
    }
    if (assignment.groupId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "A user subject assignment must not carry a groupId",
      });
    }
    return;
  }
  if (assignment.groupId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["groupId"],
      message: "A group subject assignment requires a groupId",
    });
  }
  if (assignment.membershipId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["membershipId"],
      message: "A group subject assignment must not carry a membershipId",
    });
  }
}

export const projectionRoleAssignmentSchema = z
  .strictObject({
    roleAssignmentId: z.string().min(1),
    tenantId: z.string().min(1),
    subjectType: accessProjectionSubjectTypeSchema,
    membershipId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    roleId: z.string().min(1),
    expiresAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine(assertExactlyOneAssignmentSubject);
export type ProjectionRoleAssignment = z.infer<typeof projectionRoleAssignmentSchema>;

// Per-resource role assignment. Same subject rule. The (resourceTypeId,
// externalId) pair names the resource node; cascade to descendants is inherent
// in the check (it walks the resource graph upward).
export const projectionResourceRoleAssignmentSchema = z
  .strictObject({
    resourceRoleAssignmentId: z.string().min(1),
    tenantId: z.string().min(1),
    subjectType: accessProjectionSubjectTypeSchema,
    membershipId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    roleId: z.string().min(1),
    resourceTypeId: z.string().min(1),
    externalId: z.string().min(1),
    expiresAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine(assertExactlyOneAssignmentSubject);
export type ProjectionResourceRoleAssignment = z.infer<
  typeof projectionResourceRoleAssignmentSchema
>;

export const projectionUserSchema = z.strictObject({
  herculesAuthUserId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  emailVerified: z.boolean(),
  image: z.string().optional(),
  phone: z.string().optional(),
  phoneVerified: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionUser = z.infer<typeof projectionUserSchema>;

// ── change identities (discriminated by entityType) ───────────────────────────
export const projectionChangeOperationSchema = z.enum(["upsert", "delete"]);
export type ProjectionChangeOperation = z.infer<typeof projectionChangeOperationSchema>;

export const projectionTenantChangeSchema = z.strictObject({
  entityType: z.literal("tenant"),
  tenantId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionRoleChangeSchema = z.strictObject({
  entityType: z.literal("role"),
  roleId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionPermissionChangeSchema = z.strictObject({
  entityType: z.literal("permission"),
  permissionId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionRolePermissionChangeSchema = z.strictObject({
  entityType: z.literal("role_permission"),
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionResourceTypeChangeSchema = z.strictObject({
  entityType: z.literal("resource_type"),
  resourceTypeId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionMembershipChangeSchema = z.strictObject({
  entityType: z.literal("membership"),
  membershipId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionGroupChangeSchema = z.strictObject({
  entityType: z.literal("group"),
  groupId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionGroupMembershipChangeSchema = z.strictObject({
  entityType: z.literal("group_membership"),
  groupId: z.string().min(1),
  membershipId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionRoleAssignmentChangeSchema = z.strictObject({
  entityType: z.literal("role_assignment"),
  roleAssignmentId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionResourceRoleAssignmentChangeSchema = z.strictObject({
  entityType: z.literal("resource_role_assignment"),
  resourceRoleAssignmentId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export const projectionUserChangeSchema = z.strictObject({
  entityType: z.literal("user"),
  herculesAuthUserId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});

export const projectionChangeSchema = z.discriminatedUnion("entityType", [
  projectionTenantChangeSchema,
  projectionRoleChangeSchema,
  projectionPermissionChangeSchema,
  projectionRolePermissionChangeSchema,
  projectionResourceTypeChangeSchema,
  projectionMembershipChangeSchema,
  projectionGroupChangeSchema,
  projectionGroupMembershipChangeSchema,
  projectionRoleAssignmentChangeSchema,
  projectionResourceRoleAssignmentChangeSchema,
  projectionUserChangeSchema,
]);
export type ProjectionChange = z.infer<typeof projectionChangeSchema>;
export type ProjectionEntityType = ProjectionChange["entityType"];

// ── the eleven entity arrays carried by both payload kinds ────────────────────
const entityArrays = {
  tenants: z.array(projectionTenantSchema),
  roles: z.array(projectionRoleSchema),
  permissions: z.array(projectionPermissionSchema),
  rolePermissions: z.array(projectionRolePermissionSchema),
  resourceTypes: z.array(projectionResourceTypeSchema),
  memberships: z.array(projectionMembershipSchema),
  groups: z.array(projectionGroupSchema),
  groupMemberships: z.array(projectionGroupMembershipSchema),
  roleAssignments: z.array(projectionRoleAssignmentSchema),
  resourceRoleAssignments: z.array(projectionResourceRoleAssignmentSchema),
  users: z.array(projectionUserSchema),
} as const;

// ── snapshot (bootstrap / reset) ──────────────────────────────────────────────
export const accessProjectionSnapshotSchema = z
  .strictObject({
    type: z.literal("access.projection.snapshot"),
    schemaVersion: z.literal(5),
    eventId: z.string().min(1),
    mode: z.enum(["initialize", "reset"]),
    sourceVersion: z.number().int().nonnegative(),
    expectedIssuer: z.string().min(1),
    ...entityArrays,
  })
  .superRefine((payload, ctx) => {
    const primaryTenants = payload.tenants.filter((tenant) => tenant.isPrimaryTenant);
    if (primaryTenants.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["tenants"],
        message: "Exactly one primary tenant is required",
      });
    }
  });
export type AccessProjectionSnapshot = z.infer<typeof accessProjectionSnapshotSchema>;

// ── event (normal delivery) ──────────────────────────────────────────────────
export const accessProjectionEventSchema = z
  .strictObject({
    type: z.literal("access.projection.event"),
    schemaVersion: z.literal(5),
    eventId: z.string().min(1),
    sourceVersion: z.number().int().nonnegative(),
    changes: z.array(projectionChangeSchema),
    ...entityArrays,
  })
  .superRefine((event, ctx) => {
    for (const [index, change] of event.changes.entries()) {
      const matches = countEventRows(event, change);
      if (change.operation === "upsert" && matches !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", index],
          message: `upsert ${changeKey(change)} expected exactly 1 row, found ${matches}`,
        });
      }
      if (change.operation === "delete" && matches !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", index],
          message: `delete ${changeKey(change)} expected 0 rows, found ${matches}`,
        });
      }
    }
  });
export type AccessProjectionEvent = z.infer<typeof accessProjectionEventSchema>;

export const accessProjectionSyncPayloadSchema = z.union([
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
]);
export type AccessProjectionSyncPayload = z.infer<typeof accessProjectionSyncPayloadSchema>;

// ── integrity helpers ─────────────────────────────────────────────────────────
function changeKey(change: ProjectionChange): string {
  switch (change.entityType) {
    case "tenant":
      return `tenant:${change.tenantId}`;
    case "role":
      return `role:${change.roleId}`;
    case "permission":
      return `permission:${change.permissionId}`;
    case "role_permission":
      return `role_permission:${change.roleId}/${change.permissionId}`;
    case "resource_type":
      return `resource_type:${change.resourceTypeId}`;
    case "membership":
      return `membership:${change.membershipId}`;
    case "group":
      return `group:${change.groupId}`;
    case "group_membership":
      return `group_membership:${change.groupId}/${change.membershipId}`;
    case "role_assignment":
      return `role_assignment:${change.roleAssignmentId}`;
    case "resource_role_assignment":
      return `resource_role_assignment:${change.resourceRoleAssignmentId}`;
    case "user":
      return `user:${change.herculesAuthUserId}`;
  }
}

function countEventRows(event: AccessProjectionEvent, change: ProjectionChange): number {
  switch (change.entityType) {
    case "tenant":
      return event.tenants.filter((row) => row.tenantId === change.tenantId).length;
    case "role":
      return event.roles.filter((row) => row.roleId === change.roleId).length;
    case "permission":
      return event.permissions.filter((row) => row.permissionId === change.permissionId).length;
    case "role_permission":
      return event.rolePermissions.filter(
        (row) => row.roleId === change.roleId && row.permissionId === change.permissionId,
      ).length;
    case "resource_type":
      return event.resourceTypes.filter((row) => row.resourceTypeId === change.resourceTypeId)
        .length;
    case "membership":
      return event.memberships.filter((row) => row.membershipId === change.membershipId).length;
    case "group":
      return event.groups.filter((row) => row.groupId === change.groupId).length;
    case "group_membership":
      return event.groupMemberships.filter(
        (row) => row.groupId === change.groupId && row.membershipId === change.membershipId,
      ).length;
    case "role_assignment":
      return event.roleAssignments.filter((row) => row.roleAssignmentId === change.roleAssignmentId)
        .length;
    case "resource_role_assignment":
      return event.resourceRoleAssignments.filter(
        (row) => row.resourceRoleAssignmentId === change.resourceRoleAssignmentId,
      ).length;
    case "user":
      return event.users.filter((row) => row.herculesAuthUserId === change.herculesAuthUserId)
        .length;
  }
}
