import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// IAM projection mirror — v5 ReBAC storage.
//
// Eleven tables mirror the control-plane projection (each carries the
// `sourceVersion` it was last written at) plus two component-owned tables:
//   • `resources` — the resource NODE graph the app writes (never projected);
//     used to walk parent edges during a resource-scoped access check.
//   • `sync_state` — single-row version/ack state for the signed sync channel.
//
// The model is allow-only: roles hold permissions (role_permissions), subjects
// hold roles tenant-wide (role_assignments) or per-resource
// (resource_role_assignments). There is no deny, no wildcard, no override.

const sourceValidator = v.union(v.literal("system"), v.literal("iam"));
// Roles also allow a runtime-created `custom` source.
const roleSourceValidator = v.union(v.literal("system"), v.literal("iam"), v.literal("custom"));
const tenantStatusValidator = v.union(v.literal("active"), v.literal("disabled"));
const groupStatusValidator = v.union(v.literal("active"), v.literal("disabled"));
const accountEntryModeValidator = v.union(
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
const subjectTypeValidator = v.union(v.literal("user"), v.literal("group"));

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
    tenantId: v.string(),
    herculesAuthTenantId: v.string(),
    name: v.string(),
    isPrimaryTenant: v.boolean(),
    status: tenantStatusValidator,
    accountEntryMode: accountEntryModeValidator,
    defaultRoleId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_tenant_id", ["tenantId"])
    .index("by_hercules_auth_tenant_id", ["herculesAuthTenantId"])
    .index("by_primary", ["isPrimaryTenant"]),

  roles: defineTable({
    roleId: v.string(),
    key: v.string(),
    name: v.string(),
    description: v.union(v.string(), v.null()),
    // Tenant scope: null = SHARED (usable in every tenant); a tenant id = the
    // OWNING tenant of a tenant-scoped role (only usable in that tenant).
    tenantId: v.union(v.string(), v.null()),
    source: roleSourceValidator,
    isRestricted: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_role_id", ["roleId"])
    .index("by_key", ["key"])
    .index("by_tenant", ["tenantId"]),

  permissions: defineTable({
    permissionId: v.string(),
    key: v.string(),
    resourceType: v.string(),
    action: v.string(),
    source: sourceValidator,
    isRestricted: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_permission_id", ["permissionId"])
    .index("by_key", ["key"]),

  // Identity is (roleId, permissionId).
  role_permissions: defineTable({
    roleId: v.string(),
    permissionId: v.string(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_role", ["roleId"])
    .index("by_permission", ["permissionId"])
    .index("by_role_permission", ["roleId", "permissionId"]),

  resource_types: defineTable({
    resourceTypeId: v.string(),
    key: v.string(),
    name: v.string(),
    parentResourceTypeId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_resource_type_id", ["resourceTypeId"])
    .index("by_key", ["key"]),

  memberships: defineTable({
    membershipId: v.string(),
    tenantId: v.string(),
    herculesAuthUserId: v.string(),
    status: membershipStatusValidator,
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_membership_id", ["membershipId"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_user", ["tenantId", "herculesAuthUserId"])
    .index("by_auth_user", ["herculesAuthUserId"]),

  groups: defineTable({
    groupId: v.string(),
    tenantId: v.string(),
    name: v.string(),
    status: groupStatusValidator,
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_group_id", ["groupId"])
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
    .index("by_group_membership", ["groupId", "membershipId"])
    .index("by_tenant", ["tenantId"]),

  role_assignments: defineTable({
    roleAssignmentId: v.string(),
    tenantId: v.string(),
    subjectType: subjectTypeValidator,
    membershipId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    roleId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["roleAssignmentId"])
    .index("by_tenant", ["tenantId"])
    .index("by_membership", ["membershipId"])
    .index("by_group", ["groupId"])
    .index("by_role", ["roleId"]),

  resource_role_assignments: defineTable({
    resourceRoleAssignmentId: v.string(),
    tenantId: v.string(),
    subjectType: subjectTypeValidator,
    membershipId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    roleId: v.string(),
    resourceTypeId: v.string(),
    externalId: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  })
    .index("by_assignment_id", ["resourceRoleAssignmentId"])
    .index("by_tenant", ["tenantId"])
    .index("by_membership", ["membershipId"])
    .index("by_group", ["groupId"])
    .index("by_role", ["roleId"])
    .index("by_resource_type", ["resourceTypeId"]),

  users: defineTable({
    herculesAuthUserId: v.string(),
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerified: v.boolean(),
    updatedAt: v.number(),
    sourceVersion: v.number(),
  }).index("by_auth_user_id", ["herculesAuthUserId"]),

  // Component-owned resource NODE graph. NOT projected: the app writes these via
  // resource.write and deletes them via resource.delete. `resourceType` and
  // `parentResourceType` hold catalog resource-type KEYS (the same strings the
  // app passes). The check walks parent edges upward to resolve ancestors.
  resources: defineTable({
    tenantId: v.string(),
    resourceType: v.string(),
    externalId: v.string(),
    parentResourceType: v.optional(v.string()),
    parentExternalId: v.optional(v.string()),
    data: v.optional(v.any()),
    updatedAt: v.number(),
  })
    .index("by_resource", ["tenantId", "resourceType", "externalId"])
    .index("by_parent", ["tenantId", "parentResourceType", "parentExternalId"]),
});
