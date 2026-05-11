import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sync_state: defineTable({
    key: v.string(),
    accessScopeId: v.string(),
    accessScopeAppId: v.string(),
    projectionId: v.string(),
    sourceVersion: v.number(),
    expectedIssuer: v.string(),
    accountEntryMode: v.union(
      v.literal("open"),
      v.literal("allowlisted_only"),
      v.literal("invite_only"),
      v.literal("approval_required"),
    ),
    defaultRoleId: v.string(),
    lastEventId: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

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
    updatedAt: v.number(),
  })
    .index("by_principal_id", ["principalId"])
    .index("by_scope_auth_user", ["accessScopeId", "herculesAuthUserId"])
    .index("by_scope_type", ["accessScopeId", "type"])
    .index("by_scope_status", ["accessScopeId", "status"]),

  principal_memberships: defineTable({
    accessScopeId: v.string(),
    groupPrincipalId: v.string(),
    memberPrincipalId: v.string(),
    updatedAt: v.number(),
  })
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
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_resource_action", ["accessScopeId", "resourceType", "action"]),

  role_permissions: defineTable({
    accessScopeId: v.string(),
    roleId: v.string(),
    permissionId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_role", ["accessScopeId", "roleId"])
    .index("by_permission", ["accessScopeId", "permissionId"])
    .index("by_role_permission", ["accessScopeId", "roleId", "permissionId"]),

  role_assignments: defineTable({
    accessScopeId: v.string(),
    assignmentId: v.string(),
    principalId: v.string(),
    roleId: v.string(),
    targetType: v.union(
      v.literal("scope"),
      v.literal("app"),
      v.literal("org"),
      v.literal("resource"),
    ),
    targetId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_assignment_id", ["assignmentId"])
    .index("by_principal", ["accessScopeId", "principalId"])
    .index("by_target", ["accessScopeId", "targetType", "targetId"])
    .index("by_principal_target", [
      "accessScopeId",
      "principalId",
      "targetType",
      "targetId",
    ]),
});
