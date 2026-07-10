import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// IAM projection mirror - v5 ReBAC storage.
//
// Thirteen tables mirror the control-plane projection (each carries the
// `sourceVersion` it was last written at) plus two component-owned tables:
//   • `resources` - the resource NODE graph the app writes (never projected);
//     used to walk parent edges during a resource-scoped access check.
//   • `sync_state` - single-row version/ack state for the signed sync channel.
//
// The model is allow-only: roles hold permissions (role_permissions), and
// subjects hold roles tenant-wide ({user,group}_role_assignments) or per-resource
// ({user,group}_resource_role_assignments) - split by subject type. There is no
// deny, no wildcard, no override.
//
// Id convention: each owning table stores its own control-plane id as `id` (the
// value projected from the backend PK; distinct from Convex `_id`), looked up by
// its `by_<entity>_id` index (e.g. by_tenant_id). Columns that REFERENCE another table keep the
// qualified name (tenantId, roleId, membershipId, groupId, …). Junction tables
// (role_permissions, group_memberships) have no own id - their identity is the
// FK pair.

const tenantStatusValidator = v.union(v.literal("active"), v.literal("archived"));
const groupStatusValidator = v.union(v.literal("active"), v.literal("archived"));
const accessModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);
const membershipStatusValidator = v.union(
  v.literal("active"),
  v.literal("blocked"),
  v.literal("suspended"),
  v.literal("pending_approval"),
  v.literal("removed"),
);

export default defineSchema({
  // Single-row version/ack state for the signed sync channel.
  sync_state: defineTable({
    sourceVersion: v.number(),
    expectedIssuer: v.string(),
    lastEventId: v.optional(v.string()),
    lastSyncedAt: v.number(),
    lastError: v.optional(v.string()),
  }),

  tenants: defineTable({
    id: v.string(),
    name: v.string(),
    isPrimaryTenant: v.boolean(),
    status: tenantStatusValidator,
    accessMode: accessModeValidator,
    defaultRoleId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_tenant_id", ["id"])
    .index("by_primary", ["isPrimaryTenant"]),

  users: defineTable({
    id: v.string(),
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    // The avatar URL. Stored as `image` because the sync protocol writes that
    // field name; the read surface exposes it as `avatar` (see toUserRecord /
    // memberUser in queries.ts). Do not rename either side independently.
    image: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerified: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_user_id", ["id"])
    .index("by_email", ["email"]),

  // A user's membership in a tenant.
  tenant_memberships: defineTable({
    id: v.string(),
    tenantId: v.string(),
    // The end user's OIDC subject (their Hercules Auth user id).
    userId: v.string(),
    status: membershipStatusValidator,
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_membership_id", ["id"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_user", ["tenantId", "userId"])
    .index("by_user", ["userId"]),

  groups: defineTable({
    id: v.string(),
    tenantId: v.string(),
    description: v.optional(v.string()),
    name: v.string(),
    status: groupStatusValidator,
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_group_id", ["id"])
    .index("by_tenant", ["tenantId"]),

  // Identity is (groupId, membershipId).
  group_memberships: defineTable({
    groupId: v.string(),
    membershipId: v.string(),
    tenantId: v.string(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_membership", ["membershipId"])
    .index("by_group_membership", ["groupId", "membershipId"]),

  roles: defineTable({
    id: v.string(),
    key: v.string(),
    name: v.string(),
    description: v.union(v.string(), v.null()),
    // Role scope (read together with isAppScope):
    //   • tenantId = <id> → TENANT-SCOPED: usable only in that tenant (a role
    //     created at runtime inside a tenant).
    //   • tenantId = null → not tenant-owned; isAppScope splits it:
    //       - isAppScope = false → SHARED: usable in every tenant (catalog role).
    //       - isAppScope = true  → APP-SCOPED: app-wide authority, grantable only
    //                              to primary-tenant members.
    tenantId: v.union(v.string(), v.null()),
    isAppScope: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_role_id", ["id"])
    .index("by_key", ["key"])
    .index("by_tenant", ["tenantId"]),

  // `key` (`resourceType:action`) is the identity used by checks; the parsed
  // resourceType/action halves live in the control plane and are not mirrored.
  // All permissions are app-defined - there are no pre-defined/system permissions.
  permissions: defineTable({
    id: v.string(),
    key: v.string(),
    // App-scoped permission (vs tenant-scoped), mirroring the role-level scope.
    isAppScope: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_permission_id", ["id"])
    .index("by_key", ["key"]),

  // Identity is (roleId, permissionId).
  role_permissions: defineTable({
    roleId: v.string(),
    permissionId: v.string(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_role", ["roleId"])
    .index("by_role_permission", ["roleId", "permissionId"]),

  resource_types: defineTable({
    id: v.string(),
    key: v.string(),
    name: v.string(),
    parentResourceTypeId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_resource_type_id", ["id"])
    .index("by_key", ["key"]),

  // Component-owned resource NODE graph. NOT projected: the app writes these via
  // resource.write and deletes them via resource.delete. `resourceTypeId` points
  // at a resource_types row; `externalId` is the app's own id for the resource;
  // `parentId` points at the parent resource node's `id`. The check walks parent
  // edges upward (via parentId) to resolve ancestors.
  resources: defineTable({
    id: v.string(),
    tenantId: v.string(),
    resourceTypeId: v.string(),
    externalId: v.string(),
    parentId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_resource_id", ["id"])
    .index("by_resource", ["tenantId", "resourceTypeId", "externalId"])
    .index("by_parent", ["parentId"]),

  // A tenant membership holds a role tenant-wide.
  user_role_assignments: defineTable({
    id: v.string(),
    tenantId: v.string(),
    membershipId: v.string(),
    roleId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["id"])
    .index("by_membership", ["membershipId"])
    .index("by_role_id", ["roleId"]),

  // A group holds a role tenant-wide.
  group_role_assignments: defineTable({
    id: v.string(),
    tenantId: v.string(),
    groupId: v.string(),
    roleId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["id"])
    .index("by_group", ["groupId"])
    .index("by_role_id", ["roleId"]),

  // A tenant membership holds a role on a specific resource.
  user_resource_role_assignments: defineTable({
    id: v.string(),
    tenantId: v.string(),
    membershipId: v.string(),
    roleId: v.string(),
    resourceTypeId: v.string(),
    // The target resource's app-supplied external id (NOT this row's own id).
    externalId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["id"])
    .index("by_membership", ["membershipId"]),

  // A group holds a role on a specific resource.
  group_resource_role_assignments: defineTable({
    id: v.string(),
    tenantId: v.string(),
    groupId: v.string(),
    roleId: v.string(),
    resourceTypeId: v.string(),
    // The target resource's app-supplied external id (NOT this row's own id).
    externalId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["id"])
    .index("by_group", ["groupId"]),
});
