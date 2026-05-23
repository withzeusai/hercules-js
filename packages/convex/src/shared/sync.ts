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

const roleSchema = z.object({
  roleId: z.string().min(1),
  key: z.string().min(1),
  kind: z.enum(["system", "custom"]),
  name: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

const permissionSchema = z.object({
  permissionId: z.string().min(1),
  key: z.string().min(1),
  resourceType: z.string().min(1),
  action: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

const rolePermissionSchema = z.object({
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

export const grantObjectTypeSchema = z.enum(["scope", "resource"]);
export type GrantObjectType = z.infer<typeof grantObjectTypeSchema>;

// The producer filters grants by objectScopeId === payload.scope.accessScopeId,
// so the payload doesn't repeat objectScopeId per-row. The component derives
// it from payload.scope when storing each grant. Producer must set exactly one
// of subjectPrincipalId / subjectScopeId (DL14 CHECK on the Hercules side).
const grantSchema = z.object({
  grantId: z.string().min(1),
  subjectPrincipalId: z.string().min(1).optional(),
  subjectScopeId: z.string().min(1).optional(),
  roleId: z.string().min(1),
  objectType: grantObjectTypeSchema,
  objectId: z.string().min(1),
  objectResourceType: z.string().min(1).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
});

const entitiesSchema = z.object({
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
  | { ok: true; status: "applied" | "duplicate"; acknowledgedVersion: number }
  | {
      ok: false;
      status: "version_gap";
      currentVersion: number;
      expectedVersion: number;
      receivedVersion: number;
    }
  | { ok: false; status: "invalid_signature" | "invalid_payload" | "unsupported_schema" };
