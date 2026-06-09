// Hercules Access Control projection wire protocol — v3 (schemaVersion 3).
//
// CONSUMER side. This module mirrors, as zod schemas, the producer-side source of
// truth at packages/backend-shared/src/access-control/projection-protocol.ts in the
// hercules platform repo. Shared golden fixtures prove the two agree.
//
// Two payload kinds:
//   • snapshot — bootstrap ("initialize") or destructive rebuild ("reset"). ONE
//     aggregate, applied atomically, default scope first.
//   • event — normal delivery. A stored, complete, valid delta at an exact
//     sourceVersion.
//
// Layout rules (load-bearing): the deployment-wide catalog (reusable roles,
// permissions, base role permissions) and deployment-wide users live at the TOP
// LEVEL and are NEVER duplicated per scope. Each scope carries only its own runtime
// state (principals, memberships, tenant roles, per-scope overrides, role bindings,
// permission bindings).
import { z } from "zod";

// ── leaf enums ────────────────────────────────────────────────────────────────
export const accessProjectionEffectSchema = z.enum(["allow", "deny"]);
export type AccessProjectionEffect = z.infer<typeof accessProjectionEffectSchema>;

export const accessProjectionWildcardModeSchema = z.enum(["none", "immutable", "default"]);
export type AccessProjectionWildcardMode = z.infer<typeof accessProjectionWildcardModeSchema>;

export const accessProjectionPermissionClassificationSchema = z.enum(["delegable", "owner_only"]);
export type AccessProjectionPermissionClassification = z.infer<
  typeof accessProjectionPermissionClassificationSchema
>;

export const accessProjectionScopeKindSchema = z.enum(["default", "org", "suite"]);
export type AccessProjectionScopeKind = z.infer<typeof accessProjectionScopeKindSchema>;

export const accessProjectionScopeStatusSchema = z.enum(["active", "disabled"]);
export type AccessProjectionScopeStatus = z.infer<typeof accessProjectionScopeStatusSchema>;

export const accessProjectionAccountEntryModeSchema = z.enum([
  "open",
  "allowlisted_only",
  "invite_only",
  "approval_required",
]);
export type AccessProjectionAccountEntryMode = z.infer<
  typeof accessProjectionAccountEntryModeSchema
>;

export const accessProjectionPrincipalStatusSchema = z.enum([
  "active",
  "blocked",
  "suspended",
  "pending_approval",
]);
export type AccessProjectionPrincipalStatus = z.infer<typeof accessProjectionPrincipalStatusSchema>;

// ── deployment-wide identity ─────────────────────────────────────────────────
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

// ── deployment-wide catalog (NEVER duplicated per scope) ──────────────────────
// `baseWildcard` is the role's INTRINSIC wildcard mode only. The EFFECTIVE
// wildcard is derived per scope by the consumer and is never on the wire.
export const projectionCatalogRoleSchema = z.strictObject({
  roleId: z.string().min(1),
  key: z.string().min(1),
  source: z.enum(["system", "iam"]),
  name: z.string().min(1),
  baseWildcard: accessProjectionWildcardModeSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionCatalogRole = z.infer<typeof projectionCatalogRoleSchema>;

// Deployment-owned permission catalog. `classification` drives owner-only gating.
export const projectionCatalogPermissionSchema = z.strictObject({
  permissionId: z.string().min(1),
  key: z.string().min(1),
  resourceType: z.string().min(1),
  action: z.string().min(1),
  classification: accessProjectionPermissionClassificationSchema,
  tenantAssignable: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionCatalogPermission = z.infer<typeof projectionCatalogPermissionSchema>;

// Base role→permission mapping (deployment-wide; the catalog definition).
export const projectionCatalogRolePermissionSchema = z.strictObject({
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  effect: accessProjectionEffectSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionCatalogRolePermission = z.infer<typeof projectionCatalogRolePermissionSchema>;

export const projectionCatalogSchema = z.strictObject({
  roles: z.array(projectionCatalogRoleSchema),
  permissions: z.array(projectionCatalogPermissionSchema),
  rolePermissions: z.array(projectionCatalogRolePermissionSchema),
});
export type ProjectionCatalog = z.infer<typeof projectionCatalogSchema>;

// ── per-scope state ───────────────────────────────────────────────────────────
export const projectionScopeMetadataSchema = z.strictObject({
  accessScopeId: z.string().min(1),
  name: z.string().min(1),
  kind: accessProjectionScopeKindSchema,
  status: accessProjectionScopeStatusSchema,
  accountEntryMode: accessProjectionAccountEntryModeSchema,
  defaultRoleId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionScopeMetadata = z.infer<typeof projectionScopeMetadataSchema>;

export const projectionPrincipalSchema = z.strictObject({
  principalId: z.string().min(1),
  type: z.enum(["user", "group"]),
  herculesAuthUserId: z.string().min(1).optional(),
  status: accessProjectionPrincipalStatusSchema,
  joinedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionPrincipal = z.infer<typeof projectionPrincipalSchema>;

export const projectionPrincipalMembershipSchema = z.strictObject({
  groupPrincipalId: z.string().min(1),
  memberPrincipalId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionPrincipalMembership = z.infer<typeof projectionPrincipalMembershipSchema>;

// Org-authored role owned by THIS scope (source='tenant'). `baseWildcard` is
// always "none" for tenant roles; kept for shape parity with catalog roles.
export const projectionScopeTenantRoleSchema = z.strictObject({
  roleId: z.string().min(1),
  accessScopeId: z.string().min(1),
  key: z.string().min(1),
  source: z.literal("tenant"),
  name: z.string().min(1),
  baseWildcard: accessProjectionWildcardModeSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionScopeTenantRole = z.infer<typeof projectionScopeTenantRoleSchema>;

// One scope's override of a reusable role's base mapping. Layered over the base map.
export const projectionScopeRolePermissionOverrideSchema = z.strictObject({
  accessScopeId: z.string().min(1),
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  effect: accessProjectionEffectSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionScopeRolePermissionOverride = z.infer<
  typeof projectionScopeRolePermissionOverrideSchema
>;

// A role assigned to a principal. (resourceType, resourceId) target:
// (∅,∅)=scope, (type,∅)=type-wide, (type,id)=one exact resource.
export const projectionScopeRoleBindingSchema = z.strictObject({
  bindingId: z.string().min(1),
  subjectPrincipalId: z.string().min(1),
  roleId: z.string().min(1),
  accessScopeId: z.string().min(1),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectionScopeRoleBinding = z.infer<typeof projectionScopeRoleBindingSchema>;

// Direct permission authority. Exactly one subject: subjectPrincipalId XOR
// subjectRoleId. Same nullable (resourceType, resourceId) target shape.
export const projectionScopePermissionBindingSchema = z
  .strictObject({
    bindingId: z.string().min(1),
    subjectPrincipalId: z.string().min(1).optional(),
    subjectRoleId: z.string().min(1).optional(),
    permissionId: z.string().min(1),
    effect: accessProjectionEffectSchema,
    accessScopeId: z.string().min(1),
    resourceType: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((binding, ctx) => {
    const subjectCount = [binding.subjectPrincipalId, binding.subjectRoleId].filter(
      (value) => value !== undefined,
    ).length;
    if (subjectCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one permission binding subject is required (principal XOR role)",
      });
    }
  });
export type ProjectionScopePermissionBinding = z.infer<
  typeof projectionScopePermissionBindingSchema
>;

export const projectionScopeSchema = z.strictObject({
  scope: projectionScopeMetadataSchema,
  principals: z.array(projectionPrincipalSchema),
  principalMemberships: z.array(projectionPrincipalMembershipSchema),
  roles: z.array(projectionScopeTenantRoleSchema),
  rolePermissionOverrides: z.array(projectionScopeRolePermissionOverrideSchema),
  roleBindings: z.array(projectionScopeRoleBindingSchema),
  permissionBindings: z.array(projectionScopePermissionBindingSchema),
});
export type ProjectionScope = z.infer<typeof projectionScopeSchema>;

// ── snapshot (bootstrap / reset) ──────────────────────────────────────────────
// Top-level order: metadata, deployment-wide catalog, deployment-wide users, then
// scopes (default scope first, then every organization/suite scope). Applied
// atomically: no scope becomes visible before the whole snapshot commits.
export const accessProjectionSnapshotSchema = z
  .strictObject({
    type: z.literal("access.projection.snapshot"),
    schemaVersion: z.literal(3),
    eventId: z.string().min(1),
    mode: z.enum(["initialize", "reset"]),
    sourceVersion: z.number().int().nonnegative(),
    expectedIssuer: z.string().min(1),
    catalog: projectionCatalogSchema,
    users: z.array(projectionUserSchema),
    scopes: z.array(projectionScopeSchema).min(1),
  })
  .superRefine((payload, ctx) => {
    const scopeIds = new Set<string>();
    let defaultScopeCount = 0;
    for (const [index, entry] of payload.scopes.entries()) {
      const scopeId = entry.scope.accessScopeId;
      if (scopeIds.has(scopeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["scopes", index, "scope", "accessScopeId"],
          message: "Projection snapshot scope ids must be unique",
        });
      }
      scopeIds.add(scopeId);
      if (entry.scope.kind === "default") {
        defaultScopeCount += 1;
        if (index !== 0) {
          ctx.addIssue({
            code: "custom",
            path: ["scopes", index, "scope", "kind"],
            message: "The default scope must be first",
          });
        }
      }
    }
    if (defaultScopeCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "Exactly one default scope is required",
      });
    }
  });
export type AccessProjectionSnapshot = z.infer<typeof accessProjectionSnapshotSchema>;

// ── event change identities (discriminated by entityType) ─────────────────────
// A change identity is the entity's STABLE natural key — never an opaque composite
// string, and never a mutable column. role_permission identity is (roleId,
// permissionId), NOT effect; override identity excludes effect; membership identity
// is the pair of principal ids.
export const projectionChangeOperationSchema = z.enum(["upsert", "delete"]);
export type ProjectionChangeOperation = z.infer<typeof projectionChangeOperationSchema>;

export const projectionUserChangeSchema = z.strictObject({
  entityType: z.literal("user"),
  herculesAuthUserId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionUserChange = z.infer<typeof projectionUserChangeSchema>;

// Catalog (reusable) role in a catalog delta; tenant role in a scope delta. Same
// identity (roleId); the enclosing block selects which role table it matches.
export const projectionRoleChangeSchema = z.strictObject({
  entityType: z.literal("role"),
  roleId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionRoleChange = z.infer<typeof projectionRoleChangeSchema>;

export const projectionPermissionChangeSchema = z.strictObject({
  entityType: z.literal("permission"),
  permissionId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionPermissionChange = z.infer<typeof projectionPermissionChangeSchema>;

export const projectionRolePermissionChangeSchema = z.strictObject({
  entityType: z.literal("role_permission"),
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionRolePermissionChange = z.infer<typeof projectionRolePermissionChangeSchema>;

export const projectionScopeMetaChangeSchema = z.strictObject({
  entityType: z.literal("scope"),
  accessScopeId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionScopeMetaChange = z.infer<typeof projectionScopeMetaChangeSchema>;

export const projectionPrincipalChangeSchema = z.strictObject({
  entityType: z.literal("principal"),
  principalId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionPrincipalChange = z.infer<typeof projectionPrincipalChangeSchema>;

export const projectionPrincipalMembershipChangeSchema = z.strictObject({
  entityType: z.literal("principal_membership"),
  groupPrincipalId: z.string().min(1),
  memberPrincipalId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionPrincipalMembershipChange = z.infer<
  typeof projectionPrincipalMembershipChangeSchema
>;

export const projectionRolePermissionOverrideChangeSchema = z.strictObject({
  entityType: z.literal("role_permission_override"),
  accessScopeId: z.string().min(1),
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionRolePermissionOverrideChange = z.infer<
  typeof projectionRolePermissionOverrideChangeSchema
>;

export const projectionRoleBindingChangeSchema = z.strictObject({
  entityType: z.literal("role_binding"),
  bindingId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionRoleBindingChange = z.infer<typeof projectionRoleBindingChangeSchema>;

export const projectionPermissionBindingChangeSchema = z.strictObject({
  entityType: z.literal("permission_binding"),
  bindingId: z.string().min(1),
  operation: projectionChangeOperationSchema,
});
export type ProjectionPermissionBindingChange = z.infer<
  typeof projectionPermissionBindingChangeSchema
>;

// Each delta block accepts only its own entity kinds (contract point 3, enforced at
// the type level here by the discriminated union; revalidated at runtime by the
// integrity superRefine below).
export const projectionCatalogChangeSchema = z.discriminatedUnion("entityType", [
  projectionRoleChangeSchema,
  projectionPermissionChangeSchema,
  projectionRolePermissionChangeSchema,
]);
export type ProjectionCatalogChange = z.infer<typeof projectionCatalogChangeSchema>;

export const projectionScopeChangeSchema = z.discriminatedUnion("entityType", [
  projectionScopeMetaChangeSchema,
  projectionPrincipalChangeSchema,
  projectionPrincipalMembershipChangeSchema,
  projectionRoleChangeSchema,
  projectionRolePermissionOverrideChangeSchema,
  projectionRoleBindingChangeSchema,
  projectionPermissionBindingChangeSchema,
]);
export type ProjectionScopeChange = z.infer<typeof projectionScopeChangeSchema>;

export const projectionChangeSchema = z.discriminatedUnion("entityType", [
  projectionUserChangeSchema,
  projectionRoleChangeSchema,
  projectionPermissionChangeSchema,
  projectionRolePermissionChangeSchema,
  projectionScopeMetaChangeSchema,
  projectionPrincipalChangeSchema,
  projectionPrincipalMembershipChangeSchema,
  projectionRolePermissionOverrideChangeSchema,
  projectionRoleBindingChangeSchema,
  projectionPermissionBindingChangeSchema,
]);
export type ProjectionChange = z.infer<typeof projectionChangeSchema>;
export type ProjectionEntityType = ProjectionChange["entityType"];

// ── event delta blocks ────────────────────────────────────────────────────────
// Deployment-wide catalog delta (e.g. an iam.jsonc apply). `changes` only names
// catalog entity types (role/permission/role_permission).
export const projectionCatalogDeltaSchema = z.strictObject({
  changes: z.array(projectionCatalogChangeSchema),
  roles: z.array(projectionCatalogRoleSchema),
  permissions: z.array(projectionCatalogPermissionSchema),
  rolePermissions: z.array(projectionCatalogRolePermissionSchema),
});
export type ProjectionCatalogDelta = z.infer<typeof projectionCatalogDeltaSchema>;

// Deployment-wide user delta (profile changes). `changes` only names `user`.
export const projectionUserDeltaSchema = z.strictObject({
  changes: z.array(projectionUserChangeSchema),
  users: z.array(projectionUserSchema),
});
export type ProjectionUserDelta = z.infer<typeof projectionUserDeltaSchema>;

// One scope's delta. `scope` is present when the scope metadata is upserted
// (including scope creation); a scope deletion is a `changes` entry with
// entityType `scope`, operation `delete`, and the scope's accessScopeId.
export const projectionScopeDeltaSchema = z.strictObject({
  accessScopeId: z.string().min(1),
  scope: projectionScopeMetadataSchema.optional(),
  changes: z.array(projectionScopeChangeSchema),
  principals: z.array(projectionPrincipalSchema),
  principalMemberships: z.array(projectionPrincipalMembershipSchema),
  roles: z.array(projectionScopeTenantRoleSchema),
  rolePermissionOverrides: z.array(projectionScopeRolePermissionOverrideSchema),
  roleBindings: z.array(projectionScopeRoleBindingSchema),
  permissionBindings: z.array(projectionScopePermissionBindingSchema),
});
export type ProjectionScopeDelta = z.infer<typeof projectionScopeDeltaSchema>;

// ── event (normal delivery) ──────────────────────────────────────────────────
// A stored event is ALWAYS complete and valid: every `upsert` change ships its full
// row in the matching array; every `delete` change ships only its id. At least one
// of catalog/users/scopes is present, and the integrity rule (contract point C3) is
// enforced by the superRefine, mirroring `assertProjectionEventIntegrity`.
export const accessProjectionEventSchema = z
  .strictObject({
    type: z.literal("access.projection.event"),
    schemaVersion: z.literal(3),
    eventId: z.string().min(1),
    sourceVersion: z.number().int().nonnegative(),
    catalog: projectionCatalogDeltaSchema.optional(),
    users: projectionUserDeltaSchema.optional(),
    scopes: z.array(projectionScopeDeltaSchema).optional(),
  })
  .superRefine((event, ctx) => {
    if (event.catalog === undefined && event.users === undefined && event.scopes === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "event has no catalog, users, or scopes delta block",
      });
    }

    const checkRows = (
      path: (string | number)[],
      change: ProjectionChange,
      matches: number,
    ): void => {
      if (change.operation === "upsert" && matches !== 1) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `upsert ${changeKey(change)} expected exactly 1 row, found ${matches}`,
        });
      }
      if (change.operation === "delete" && matches !== 0) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `delete ${changeKey(change)} expected 0 rows, found ${matches}`,
        });
      }
    };

    if (event.catalog) {
      for (const [index, change] of event.catalog.changes.entries()) {
        checkRows(["catalog", "changes", index], change, countCatalogRows(event.catalog, change));
      }
    }
    if (event.users) {
      for (const [index, change] of event.users.changes.entries()) {
        const matches = event.users.users.filter(
          (u) => u.herculesAuthUserId === change.herculesAuthUserId,
        ).length;
        checkRows(["users", "changes", index], change, matches);
      }
    }
    for (const [scopeIndex, scope] of (event.scopes ?? []).entries()) {
      for (const [index, change] of scope.changes.entries()) {
        checkRows(["scopes", scopeIndex, "changes", index], change, countScopeRows(scope, change));
      }
    }
  });
export type AccessProjectionEvent = z.infer<typeof accessProjectionEventSchema>;

export const accessProjectionSyncPayloadSchema = z.union([
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
]);
export type AccessProjectionSyncPayload = z.infer<typeof accessProjectionSyncPayloadSchema>;

// ── integrity helpers (mirror of producer assertProjectionEventIntegrity) ──────
function changeKey(change: ProjectionChange): string {
  switch (change.entityType) {
    case "user":
      return `user:${change.herculesAuthUserId}`;
    case "role":
      return `role:${change.roleId}`;
    case "permission":
      return `permission:${change.permissionId}`;
    case "role_permission":
      return `role_permission:${change.roleId}/${change.permissionId}`;
    case "scope":
      return `scope:${change.accessScopeId}`;
    case "principal":
      return `principal:${change.principalId}`;
    case "principal_membership":
      return `principal_membership:${change.groupPrincipalId}/${change.memberPrincipalId}`;
    case "role_permission_override":
      return `role_permission_override:${change.accessScopeId}/${change.roleId}/${change.permissionId}`;
    case "role_binding":
      return `role_binding:${change.bindingId}`;
    case "permission_binding":
      return `permission_binding:${change.bindingId}`;
  }
}

function countCatalogRows(
  catalog: ProjectionCatalogDelta,
  change: ProjectionCatalogChange,
): number {
  switch (change.entityType) {
    case "role":
      return catalog.roles.filter((r) => r.roleId === change.roleId).length;
    case "permission":
      return catalog.permissions.filter((p) => p.permissionId === change.permissionId).length;
    case "role_permission":
      return catalog.rolePermissions.filter(
        (rp) => rp.roleId === change.roleId && rp.permissionId === change.permissionId,
      ).length;
  }
}

function countScopeRows(scope: ProjectionScopeDelta, change: ProjectionScopeChange): number {
  switch (change.entityType) {
    case "scope":
      return scope.scope !== undefined && scope.accessScopeId === change.accessScopeId ? 1 : 0;
    case "principal":
      return scope.principals.filter((p) => p.principalId === change.principalId).length;
    case "principal_membership":
      return scope.principalMemberships.filter(
        (m) =>
          m.groupPrincipalId === change.groupPrincipalId &&
          m.memberPrincipalId === change.memberPrincipalId,
      ).length;
    case "role":
      return scope.roles.filter((r) => r.roleId === change.roleId).length;
    case "role_permission_override":
      return scope.rolePermissionOverrides.filter(
        (o) =>
          o.accessScopeId === change.accessScopeId &&
          o.roleId === change.roleId &&
          o.permissionId === change.permissionId,
      ).length;
    case "role_binding":
      return scope.roleBindings.filter((b) => b.bindingId === change.bindingId).length;
    case "permission_binding":
      return scope.permissionBindings.filter((b) => b.bindingId === change.bindingId).length;
  }
}
