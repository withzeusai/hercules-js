import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// IAM projection mirror — v3 deployment-scoped storage.
//
// The deployment-wide catalog (reusable roles, permissions, base role
// permissions) and deployment-wide users are stored ONCE (never duplicated per
// scope). Each scope owns its runtime state: principals, memberships, tenant
// roles, per-scope role-permission overrides, role bindings, and permission
// bindings. The old polymorphic `grants` table is split into `role_bindings`
// (role membership) and `permission_bindings` (direct permission authority).

const effectValidator = v.union(v.literal("allow"), v.literal("deny"));
const bindingAppliesToValidator = v.union(v.literal("self"), v.literal("self_and_descendants"));
const wildcardValidator = v.union(v.literal("none"), v.literal("immutable"), v.literal("default"));
const scopeKindValidator = v.union(v.literal("default"), v.literal("org"), v.literal("suite"));
const scopeStatusValidator = v.union(v.literal("active"), v.literal("disabled"));
const accountEntryModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);
const principalStatusValidator = v.union(
  v.literal("active"),
  v.literal("blocked"),
  v.literal("suspended"),
  v.literal("pending_approval"),
  v.literal("removed"),
);

export default defineSchema({
  // Single-row version/ack state for the signed sync channel. PRESERVED from v2.
  sync_state: defineTable({
    sourceVersion: v.number(),
    expectedIssuer: v.string(),
    lastEventId: v.optional(v.string()),
    lastSyncedAt: v.number(),
    lastError: v.optional(v.string()),
  }),

  // Deployment-wide user identity/profile (ProjectionUser). Populated from the
  // top-level `users[]` snapshot array / `users` event delta — NOT per scope.
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
    kind: scopeKindValidator,
    status: scopeStatusValidator,
    accountEntryMode: accountEntryModeValidator,
    defaultRoleId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope_id", ["accessScopeId"])
    .index("by_kind", ["kind"]),

  // Product-facing organization rows derived from org/suite scopes.
  organizations: defineTable({
    accessScopeId: v.string(),
    name: v.string(),
    status: scopeStatusValidator,
    accountEntryMode: accountEntryModeValidator,
    updatedAt: v.number(),
  }).index("by_scope_id", ["accessScopeId"]),

  principals: defineTable({
    accessScopeId: v.string(),
    principalId: v.string(),
    type: v.union(v.literal("user"), v.literal("group")),
    herculesAuthUserId: v.optional(v.string()),
    // Display name for a `group` principal. A user principal's display name
    // comes from the deployment-wide `users` table, never from this row.
    name: v.optional(v.string()),
    status: principalStatusValidator,
    joinedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_principal_id", ["principalId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_auth_user", ["accessScopeId", "herculesAuthUserId"])
    .index("by_auth_user", ["herculesAuthUserId"])
    .index("by_scope_type", ["accessScopeId", "type"])
    .index("by_scope_status", ["accessScopeId", "status"])
    .index("by_scope_status_type", ["accessScopeId", "status", "type"]),

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

  // Unified role table holding BOTH deployment-wide catalog roles (source
  // system|iam, accessScopeId undefined) and per-scope tenant roles (source
  // tenant, accessScopeId set). `baseWildcard` is the role's INTRINSIC wildcard
  // mode (Owner=immutable, Admin=default, everything else=none). The EFFECTIVE
  // wildcard is DERIVED per scope at evaluation time (base role-permissions
  // UNION that scope's overrides) — never stored here.
  roles: defineTable({
    roleId: v.string(),
    key: v.string(),
    source: v.union(v.literal("system"), v.literal("iam"), v.literal("tenant")),
    name: v.string(),
    baseWildcard: wildcardValidator,
    // Undefined for catalog (reusable) roles; the owning org/suite scope for
    // tenant roles. Catalog roles are NEVER per-scope duplicated.
    accessScopeId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_role_id", ["roleId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_source", ["source"]),

  // Deployment-owned permission catalog (ProjectionCatalogPermission). Lives at
  // the top level (no per-scope duplication). `accessScopeId` is retained and
  // pinned to the default scope id so the existing default-scope lookups
  // (by_scope / by_scope_key) keep working without re-plumbing every reader.
  permissions: defineTable({
    accessScopeId: v.string(),
    permissionId: v.string(),
    key: v.string(),
    resourceType: v.string(),
    action: v.string(),
    classification: v.union(v.literal("delegable"), v.literal("owner_only")),
    // tenantAssignable=false hides this permission from org-admin role editors.
    tenantAssignable: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_permission_id", ["permissionId"])
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_key", ["accessScopeId", "key"])
    .index("by_scope_resource_action", ["accessScopeId", "resourceType", "action"]),

  // BASE role->permission map (deployment-wide; the catalog definition).
  // Identity is (roleId, permissionId) — effect is MUTABLE and is NOT part of
  // the identity (an allow<->deny flip is an upsert of the same row).
  role_permissions: defineTable({
    roleId: v.string(),
    permissionId: v.string(),
    effect: effectValidator,
    updatedAt: v.number(),
  })
    .index("by_role", ["roleId"])
    .index("by_permission", ["permissionId"])
    .index("by_role_permission", ["roleId", "permissionId"]),

  // One scope's override of a reusable role's base mapping. Identity is
  // (accessScopeId, roleId, permissionId); effect is mutable (not in identity).
  // Layered over the base map during evaluation.
  role_permission_overrides: defineTable({
    accessScopeId: v.string(),
    roleId: v.string(),
    permissionId: v.string(),
    effect: effectValidator,
    updatedAt: v.number(),
  })
    .index("by_scope", ["accessScopeId"])
    .index("by_scope_role", ["accessScopeId", "roleId"])
    .index("by_permission", ["permissionId"])
    .index("by_role", ["roleId"])
    .index("by_scope_role_permission", ["accessScopeId", "roleId", "permissionId"]),

  // Role assigned to a principal (the role half of the old `grants`). The
  // (resourceType, resourceId) target tuple replaces the old object addressing:
  //   (undefined, undefined) = the scope, (type, undefined) = every resource of
  //   a type, (type, id) = one exact resource.
  role_bindings: defineTable({
    bindingId: v.string(),
    subjectPrincipalId: v.string(),
    roleId: v.string(),
    accessScopeId: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    appliesTo: bindingAppliesToValidator,
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_binding_id", ["bindingId"])
    .index("by_scope", ["accessScopeId"])
    // Scope-object role lookup (resourceType undefined): who has which role on a
    // scope. Used by collectGrantContributions + collectPrincipalScopeRoles.
    .index("by_subject_scope_resource", [
      "subjectPrincipalId",
      "accessScopeId",
      "resourceType",
      "resourceId",
    ])
    // Reverse: "who has a direct role binding on this resource" (membership UIs).
    .index("by_scope_resource", ["accessScopeId", "resourceType", "resourceId"])
    .index("by_role", ["roleId"])
    .index("by_subject_principal", ["subjectPrincipalId"]),

  // Direct permission authority (the direct-permission half of the old
  // `grants`). Exactly one subject: subjectPrincipalId XOR subjectRoleId. Same
  // nullable (resourceType, resourceId) target shape as role_bindings.
  permission_bindings: defineTable({
    bindingId: v.string(),
    subjectPrincipalId: v.optional(v.string()),
    subjectRoleId: v.optional(v.string()),
    permissionId: v.string(),
    effect: effectValidator,
    accessScopeId: v.string(),
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    appliesTo: bindingAppliesToValidator,
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_binding_id", ["bindingId"])
    .index("by_scope", ["accessScopeId"])
    // Principal-subject scope/resource lookups.
    .index("by_subject_principal_scope_resource", [
      "subjectPrincipalId",
      "accessScopeId",
      "resourceType",
      "resourceId",
    ])
    // Role-subject scope/resource lookups (a rule applying to every holder of a
    // role).
    .index("by_subject_role_scope_resource", [
      "subjectRoleId",
      "accessScopeId",
      "resourceType",
      "resourceId",
    ])
    // Reverse: "who has a direct permission binding on this resource".
    .index("by_scope_resource", ["accessScopeId", "resourceType", "resourceId"])
    .index("by_permission", ["permissionId"])
    .index("by_subject_principal", ["subjectPrincipalId"])
    .index("by_subject_role", ["subjectRoleId"]),
});
