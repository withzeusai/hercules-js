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
    updatedAt: v.number(),
  })
    .index("by_role_id", ["roleId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_kind", ["accessScopeId", "kind"]),

  permissions: defineTable({
    accessScopeId: v.string(),
    permissionId: v.string(),
    key: v.string(),
    resourceType: v.string(),
    action: v.string(),
    updatedAt: v.number(),
  })
    .index("by_permission_id", ["permissionId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_resource_action", ["accessScopeId", "resourceType", "action"]),

  role_permissions: defineTable({
    accessScopeId: v.string(),
    roleId: v.string(),
    permissionId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope", ["accessScopeId"])
    .index("by_role", ["accessScopeId", "roleId"])
    .index("by_permission", ["accessScopeId", "permissionId"])
    .index("by_role_permission", ["accessScopeId", "roleId", "permissionId"]),

  // DL14 unified grants table. Schema accepts every DL14 shape; authorize
  // traversal in checks.ts currently only exercises principal-subject +
  // scope-object grants (resource-object and scope-subject are stored but
  // not traversed yet).
  grants: defineTable({
    grantId: v.string(),
    subjectPrincipalId: v.optional(v.string()),
    subjectScopeId: v.optional(v.string()),
    roleId: v.string(),
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
    .index("by_role", ["roleId"]),
});
