import { z } from "zod";

export const ACCESS_CONTROL_SYNC_PATH = "/_hercules/access-control/sync";

export const principalStatusSchema = z.enum(["active", "blocked", "suspended", "pending_approval"]);
export type PrincipalStatus = z.infer<typeof principalStatusSchema>;

export const accountEntryModeSchema = z.enum([
  "open",
  "allowlisted_only",
  "invite_only",
  "approval_required",
]);
export type AccountEntryMode = z.infer<typeof accountEntryModeSchema>;

export const scopeKindSchema = z.enum(["default", "org", "suite"]);
export type ScopeKind = z.infer<typeof scopeKindSchema>;

export const scopeStatusSchema = z.enum(["active", "disabled"]);
export type ScopeStatus = z.infer<typeof scopeStatusSchema>;

export const scopeMetadataSchema = z.object({
  accessScopeId: z.string().min(1),
  name: z.string().min(1),
  kind: scopeKindSchema,
  status: scopeStatusSchema,
  accountEntryMode: accountEntryModeSchema,
  defaultRoleId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ScopeMetadata = z.infer<typeof scopeMetadataSchema>;

const userSchema = z.object({
  herculesAuthUserId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  emailVerified: z.boolean(),
  image: z.string().optional(),
  phone: z.string().optional(),
  phoneVerified: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

const principalSchema = z.object({
  principalId: z.string().min(1),
  type: z.enum(["user", "group"]),
  herculesAuthUserId: z.string().min(1).optional(),
  status: principalStatusSchema,
  joinedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const principalMembershipSchema = z.object({
  groupPrincipalId: z.string().min(1),
  memberPrincipalId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

// DL15: each role row carries its own accessScopeId — default scope for
// system roles, target org scope for custom roles. Consumer keys lookups
// on (accessScopeId, key).
const roleSchema = z.object({
  roleId: z.string().min(1),
  accessScopeId: z.string().min(1),
  key: z.string().min(1),
  kind: z.enum(["system", "custom"]),
  name: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

// Permissions are app-wide; accessScopeId always equals the default scope.
// tenantAssignable=false hides the permission from org-admin role editors.
const permissionSchema = z.object({
  permissionId: z.string().min(1),
  accessScopeId: z.string().min(1),
  key: z.string().min(1),
  resourceType: z.string().min(1),
  action: z.string().min(1),
  tenantAssignable: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

// Default-scope rows are base role -> permission mappings. Org-scope rows
// are per-org overrides (allow extends, deny removes).
const rolePermissionSchema = z.object({
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  accessScopeId: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
  updatedAt: z.number().int().nonnegative(),
});

export const grantObjectTypeSchema = z.enum(["scope", "resource"]);
export type GrantObjectType = z.infer<typeof grantObjectTypeSchema>;

// The producer filters grants by objectScopeId === payload.scope.accessScopeId,
// so the payload doesn't repeat objectScopeId per-row. The component derives
// it from payload.scope when storing each grant. Producer must set exactly one
// of subjectPrincipalId / subjectScopeId / subjectRoleId (DL14 CHECK on the
// Hercules side).
// DL15: relationKind="role" requires roleId; "direct_permission" requires
// permissionId. Producer's CHECK constraint enforces the XOR.
const grantSchema = z.object({
  grantId: z.string().min(1),
  subjectPrincipalId: z.string().min(1).optional(),
  subjectScopeId: z.string().min(1).optional(),
  subjectRoleId: z.string().min(1).optional(),
  relationKind: z.enum(["role", "direct_permission"]),
  roleId: z.string().min(1).optional(),
  permissionId: z.string().min(1).optional(),
  effect: z.enum(["allow", "deny"]),
  objectType: grantObjectTypeSchema,
  objectId: z.string().min(1),
  objectResourceType: z.string().min(1).optional(),
  appliesToAllResources: z.boolean().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
});

const entitiesSchema = z.object({
  users: z.array(userSchema),
  principals: z.array(principalSchema),
  principalMemberships: z.array(principalMembershipSchema),
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
  rolePermissions: z.array(rolePermissionSchema),
  grants: z.array(grantSchema),
});

export const accessProjectionChangeSchema = z.object({
  entityType: z.enum([
    "principal",
    "principal_membership",
    "role",
    "permission",
    "role_permission",
    "grant",
  ]),
  entityId: z.string().min(1),
  operation: z.enum(["upsert", "delete"]),
});

export const accessProjectionSnapshotSchema = z.object({
  type: z.literal("access.projection.snapshot"),
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  expectedIssuer: z.string().min(1),
  scope: scopeMetadataSchema,
  entities: entitiesSchema,
});

export type AccessProjectionSnapshot = z.infer<typeof accessProjectionSnapshotSchema>;

export const accessProjectionEventSchema = z.object({
  type: z.literal("access.projection.event"),
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  scope: scopeMetadataSchema,
  changes: z.array(accessProjectionChangeSchema),
  entities: entitiesSchema,
});

export const accessProjectionSyncPayloadSchema = z.union([
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
]);

export type AccessProjectionChange = z.infer<typeof accessProjectionChangeSchema>;
export type AccessProjectionEvent = z.infer<typeof accessProjectionEventSchema>;
export type AccessProjectionSyncPayload = z.infer<typeof accessProjectionSyncPayloadSchema>;

export type SyncResponse =
  | {
      ok: true;
      status: "applied" | "duplicate";
      acknowledgedVersion: number;
      capabilities?: { resourcePermissionRules: boolean };
    }
  | {
      ok: false;
      status: "version_gap";
      currentVersion: number;
      expectedVersion: number;
      receivedVersion: number;
    }
  | {
      ok: false;
      status:
        | "invalid_signature"
        | "invalid_payload"
        | "unsupported_schema"
        // MED-03: producer-side issuer rotation is an explicit flow, not a
        // side effect of a signed snapshot. Consumer surfaces this so the
        // producer can decide whether to retry or surface a fatal alert.
        | "issuer_mismatch";
    };
