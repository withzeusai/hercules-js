import { z } from "zod";

export const ACCESS_CONTROL_SYNC_PATH = "/_hercules/access-control/sync";
export const ACCESS_CONTROL_SYNC_STATE_KEY = "default";

export const accessTargetTypeSchema = z.enum(["scope", "app", "org", "resource"]);
export type AccessTargetType = z.infer<typeof accessTargetTypeSchema>;

export const principalStatusSchema = z.enum([
  "active",
  "blocked",
  "suspended",
  "pending_approval",
]);
export type PrincipalStatus = z.infer<typeof principalStatusSchema>;

export const accountEntryModeSchema = z.enum([
  "open",
  "allowlisted_only",
  "invite_only",
  "approval_required",
]);
export type AccountEntryMode = z.infer<typeof accountEntryModeSchema>;

const principalSchema = z.object({
  principalId: z.string().min(1),
  type: z.enum(["user", "group"]),
  herculesAuthUserId: z.string().min(1).optional(),
  status: principalStatusSchema,
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

const roleAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  principalId: z.string().min(1),
  roleId: z.string().min(1),
  targetType: accessTargetTypeSchema,
  targetId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

export const accessProjectionSnapshotSchema = z.object({
  type: z.literal("access.projection.snapshot"),
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  accessScopeId: z.string().min(1),
  accessScopeAppId: z.string().min(1),
  projectionId: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  config: z.object({
    expectedIssuer: z.string().min(1),
    accountEntryMode: accountEntryModeSchema,
    defaultRoleId: z.string().min(1),
  }),
  entities: z.object({
    principals: z.array(principalSchema),
    principalMemberships: z.array(principalMembershipSchema),
    roles: z.array(roleSchema),
    permissions: z.array(permissionSchema),
    rolePermissions: z.array(rolePermissionSchema),
    roleAssignments: z.array(roleAssignmentSchema),
  }),
});

export type AccessProjectionSnapshot = z.infer<typeof accessProjectionSnapshotSchema>;

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
