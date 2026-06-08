import { z } from "zod";

export const ACCESS_CONTROL_SYNC_PATH = "/_hercules/access-control/sync";

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

export const scopeKindSchema = z.enum(["default", "org", "suite"]);
export type ScopeKind = z.infer<typeof scopeKindSchema>;

export const scopeStatusSchema = z.enum(["active", "disabled"]);
export type ScopeStatus = z.infer<typeof scopeStatusSchema>;

export const scopeMetadataSchema = z.strictObject({
  accessScopeId: z.string().min(1),
  name: z.string().min(1),
  kind: scopeKindSchema,
  status: scopeStatusSchema,
  accountEntryMode: accountEntryModeSchema,
  defaultRoleId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type ScopeMetadata = z.infer<typeof scopeMetadataSchema>;

const userSchema = z.strictObject({
  herculesAuthUserId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  emailVerified: z.boolean(),
  image: z.string().optional(),
  phone: z.string().optional(),
  phoneVerified: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

const principalSchema = z.strictObject({
  principalId: z.string().min(1),
  type: z.enum(["user", "group"]),
  herculesAuthUserId: z.string().min(1).optional(),
  status: principalStatusSchema,
  joinedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const principalMembershipSchema = z.strictObject({
  groupPrincipalId: z.string().min(1),
  memberPrincipalId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

const roleSchema = z.strictObject({
  roleId: z.string().min(1),
  accessScopeId: z.string().min(1),
  key: z.string().min(1),
  kind: z.enum(["system", "custom"]),
  name: z.string().min(1),
  wildcard: z.enum(["none", "immutable", "default"]),
  updatedAt: z.number().int().nonnegative(),
});

export const permissionClassificationSchema = z.enum([
  "delegable",
  "owner_only",
]);
export type PermissionClassification = z.infer<
  typeof permissionClassificationSchema
>;

const permissionSchema = z.strictObject({
  permissionId: z.string().min(1),
  accessScopeId: z.string().min(1),
  key: z.string().min(1),
  resourceType: z.string().min(1),
  action: z.string().min(1),
  classification: permissionClassificationSchema,
  tenantAssignable: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

const rolePermissionSchema = z.strictObject({
  roleId: z.string().min(1),
  permissionId: z.string().min(1),
  accessScopeId: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
  updatedAt: z.number().int().nonnegative(),
});

export const grantObjectTypeSchema = z.enum(["scope", "resource"]);
export type GrantObjectType = z.infer<typeof grantObjectTypeSchema>;

const grantSchema = z
  .strictObject({
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
    expiresAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((grant, ctx) => {
    const subjectCount = [
      grant.subjectPrincipalId,
      grant.subjectScopeId,
      grant.subjectRoleId,
    ].filter((value) => value !== undefined).length;
    if (subjectCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one grant subject is required",
      });
    }

    const relationMatches =
      (grant.relationKind === "role" &&
        grant.roleId !== undefined &&
        grant.permissionId === undefined) ||
      (grant.relationKind === "direct_permission" &&
        grant.permissionId !== undefined &&
        grant.roleId === undefined);
    if (!relationMatches) {
      ctx.addIssue({
        code: "custom",
        message: "Grant relation and referenced entity must match",
      });
    }

    const targetMatches =
      (grant.objectType === "scope" &&
        grant.objectResourceType === undefined) ||
      (grant.objectType === "resource" &&
        grant.objectResourceType !== undefined);
    if (!targetMatches) {
      ctx.addIssue({
        code: "custom",
        message: "Grant resource target shape is invalid",
      });
    }
  });

export const accessProjectionEntitiesSchema = z.strictObject({
  users: z.array(userSchema),
  principals: z.array(principalSchema),
  principalMemberships: z.array(principalMembershipSchema),
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
  rolePermissions: z.array(rolePermissionSchema),
  grants: z.array(grantSchema),
});
export type AccessProjectionEntities = z.infer<
  typeof accessProjectionEntitiesSchema
>;

export const accessProjectionChangeSchema = z.strictObject({
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
export type AccessProjectionChange = z.infer<
  typeof accessProjectionChangeSchema
>;

export const accessProjectionSnapshotScopeSchema = z
  .strictObject({
    scope: scopeMetadataSchema,
    entities: accessProjectionEntitiesSchema,
  })
  .superRefine((payload, ctx) => {
    validateGrantScopes(
      payload.scope.accessScopeId,
      payload.entities.grants,
      ctx,
    );
  });
export type AccessProjectionSnapshotScope = z.infer<
  typeof accessProjectionSnapshotScopeSchema
>;

export const accessProjectionSnapshotSchema = z
  .strictObject({
    type: z.literal("access.projection.snapshot"),
    schemaVersion: z.literal(3),
    eventId: z.string().min(1),
    mode: z.enum(["initialize", "reset"]),
    sourceVersion: z.number().int().positive(),
    expectedIssuer: z.string().min(1),
    scopes: z.array(accessProjectionSnapshotScopeSchema).min(1),
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
          message: "Projection snapshot scopes must be unique",
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
export type AccessProjectionSnapshot = z.infer<
  typeof accessProjectionSnapshotSchema
>;

export const accessProjectionScopeEventSchema = z
  .strictObject({
    scope: scopeMetadataSchema,
    changes: z.array(accessProjectionChangeSchema),
    entities: accessProjectionEntitiesSchema,
  })
  .superRefine((payload, ctx) => {
    validateGrantScopes(
      payload.scope.accessScopeId,
      payload.entities.grants,
      ctx,
    );
  });
export type AccessProjectionScopeEvent = z.infer<
  typeof accessProjectionScopeEventSchema
>;

export const accessProjectionEventSchema = z
  .strictObject({
    type: z.literal("access.projection.event"),
    schemaVersion: z.literal(3),
    eventId: z.string().min(1),
    sourceVersion: z.number().int().positive(),
    scopes: z.array(accessProjectionScopeEventSchema).min(1),
  })
  .superRefine((payload, ctx) => {
    const scopeIds = new Set<string>();
    for (const [index, entry] of payload.scopes.entries()) {
      const scopeId = entry.scope.accessScopeId;
      if (scopeIds.has(scopeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["scopes", index, "scope", "accessScopeId"],
          message: "Projection event scopes must be unique",
        });
      }
      scopeIds.add(scopeId);
    }
  });
export type AccessProjectionEvent = z.infer<typeof accessProjectionEventSchema>;

export const accessProjectionSyncPayloadSchema = z.union([
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
]);
export type AccessProjectionSyncPayload = z.infer<
  typeof accessProjectionSyncPayloadSchema
>;

export function emptyAccessProjectionEntities(): AccessProjectionEntities {
  return {
    users: [],
    principals: [],
    principalMemberships: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    grants: [],
  };
}

export type SyncResponse =
  | {
      ok: true;
      status: "applied" | "duplicate";
      acknowledgedVersion: number;
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
        | "issuer_mismatch"
        | "default_scope_required";
    }
  | {
      ok: false;
      status: "not_ready" | "reset_required";
      currentVersion: number;
    };

function validateGrantScopes(
  accessScopeId: string,
  grants: AccessProjectionEntities["grants"],
  ctx: z.RefinementCtx,
): void {
  for (const [index, grant] of grants.entries()) {
    if (
      (grant.objectType === "scope" && grant.objectId !== accessScopeId) ||
      (grant.subjectScopeId !== undefined &&
        grant.subjectScopeId !== accessScopeId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["entities", "grants", index],
        message: "Grant scope target does not match the payload scope",
      });
    }
  }
}
