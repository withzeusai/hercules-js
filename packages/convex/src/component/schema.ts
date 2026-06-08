import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sync_state: defineTable({
    sourceVersion: v.number(),
    expectedIssuer: v.string(),
    lastEventId: v.optional(v.string()),
    lastSyncedAt: v.number(),
    lastError: v.optional(v.string()),
  }),

  // Hercules-managed user identity and profile data for access-control users.
  users: defineTable({
    herculesAuthUserId: v.string(),
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerified: v.boolean(),
    updatedAt: v.number(),
  }).index("by_auth_user_id", ["herculesAuthUserId"]),

  scopes: defineTable({
    accessScopeId: v.string(),
    name: v.string(),
    kind: v.union(v.literal("default"), v.literal("org"), v.literal("suite")),
    status: v.union(v.literal("active"), v.literal("disabled")),
    accountEntryMode: v.union(
      v.literal("open"),
      v.literal("allowlisted_only"),
      v.literal("invite_only"),
      v.literal("approval_required"),
    ),
    defaultRoleId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope_id", ["accessScopeId"])
    .index("by_kind", ["kind"]),

  // Product-facing organization rows are derived from authoritative org scopes.
  organizations: defineTable({
    accessScopeId: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    accountEntryMode: v.union(
      v.literal("open"),
      v.literal("allowlisted_only"),
      v.literal("invite_only"),
      v.literal("approval_required"),
    ),
    updatedAt: v.number(),
  }).index("by_scope_id", ["accessScopeId"]),

  principals: defineTable({
    accessScopeId: v.string(),
    principalId: v.string(),
    type: v.union(v.literal("user"), v.literal("group")),
    herculesAuthUserId: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("blocked"),
      v.literal("suspended"),
      v.literal("pending_approval"),
    ),
    joinedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_principal_id", ["principalId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_auth_user", ["accessScopeId", "herculesAuthUserId"])
    .index("by_auth_user", ["herculesAuthUserId"])
    .index("by_scope_type", ["accessScopeId", "type"])
    .index("by_scope_status", ["accessScopeId", "status"]),

  principal_memberships: defineTable({
    accessScopeId: v.string(),
    groupPrincipalId: v.string(),
    memberPrincipalId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope", ["accessScopeId"])
    .index("by_group", ["accessScopeId", "groupPrincipalId"])
    .index("by_member", ["accessScopeId", "memberPrincipalId"])
    .index("by_group_member", ["accessScopeId", "groupPrincipalId", "memberPrincipalId"]),

  roles: defineTable({
    accessScopeId: v.string(),
    roleId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("system"), v.literal("custom")),
    name: v.string(),
    // §0b wildcard semantic flag. Read off the role row during evaluation to
    // short-circuit Owner ("immutable") / Admin ("default"); "none" defers to
    // enumerated rows. Never queried on, so no index is needed.
    wildcard: v.union(v.literal("none"), v.literal("immutable"), v.literal("default")),
    updatedAt: v.number(),
  })
    .index("by_role_id", ["roleId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_kind", ["accessScopeId", "kind"]),

  permissions: defineTable({
    // DL15: permissions are app-wide; accessScopeId is always the default
    // scope. Kept for FK/lookup symmetry with the producer.
    accessScopeId: v.string(),
    permissionId: v.string(),
    key: v.string(),
    resourceType: v.string(),
    action: v.string(),
    classification: v.union(v.literal("delegable"), v.literal("owner_only")),
    // tenantAssignable=false hides this permission from org-admin role
    // editors. Vendor-only permissions (billing, system admin) set false.
    tenantAssignable: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_permission_id", ["permissionId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_resource_action", ["accessScopeId", "resourceType", "action"]),

  role_permissions: defineTable({
    // DL15: default-scope rows are base mappings on system roles;
    // org-scope rows are per-org overrides (allow adds, deny removes).
    accessScopeId: v.string(),
    roleId: v.string(),
    permissionId: v.string(),
    effect: v.union(v.literal("allow"), v.literal("deny")),
    updatedAt: v.number(),
  })
    .index("by_scope", ["accessScopeId"])
    .index("by_role", ["accessScopeId", "roleId"])
    .index("by_permission", ["accessScopeId", "permissionId"])
    .index("by_role_permission", ["accessScopeId", "roleId", "permissionId"])
    .index("by_role_permission_effect", ["accessScopeId", "roleId", "permissionId", "effect"]),

  // DL14 + DL15 unified grants table. relationKind="role" -> roleId set;
  // relationKind="direct_permission" -> permissionId set (per-user delta).
  // Resource-object grants and scope-subject grants are stored; authorize
  // exercises principal-subject scope-object grants (role + direct) plus
  // principal- and role-subject resource-object grants when resource args
  // are provided.
  grants: defineTable({
    grantId: v.string(),
    subjectPrincipalId: v.optional(v.string()),
    subjectScopeId: v.optional(v.string()),
    subjectRoleId: v.optional(v.string()),
    relationKind: v.union(v.literal("role"), v.literal("direct_permission")),
    roleId: v.optional(v.string()),
    permissionId: v.optional(v.string()),
    effect: v.union(v.literal("allow"), v.literal("deny")),
    objectType: v.union(v.literal("scope"), v.literal("resource")),
    objectId: v.string(),
    objectScopeId: v.string(),
    objectResourceType: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_grant_id", ["grantId"])
    .index("by_object_scope", ["objectScopeId"])
    .index("by_subject_principal_object", ["subjectPrincipalId", "objectType", "objectId"])
    .index("by_subject_principal_scope_object_resource", [
      "subjectPrincipalId",
      "objectScopeId",
      "objectType",
      "objectResourceType",
      "objectId",
    ])
    .index("by_subject_role_scope_object_resource", [
      "subjectRoleId",
      "objectScopeId",
      "objectType",
      "objectResourceType",
      "objectId",
    ])
    // Reverse lookup: "who has a direct grant on this resource" (membership UIs).
    .index("by_object_resource", ["objectScopeId", "objectType", "objectResourceType", "objectId"])
    .index("by_role", ["roleId"])
    .index("by_permission", ["permissionId"]),
});
