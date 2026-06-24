import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  type IamActionModuleContext,
  type IamPermissionGrant,
  type IamPermissionGrantInput,
  type IamPrincipalStatus,
  type IamRoleGrant,
  type IamRoleGrantInput,
  type IamTenantWriteResult,
  normalizeGrant,
  normalizeTenantWriteResult,
  optionalString,
  permissionGrantBody,
  permissionGrantValidator,
  requiredNumber,
  requiredPrincipalStatus,
  requiredRecordArray,
  requiredString,
  requiredStringArray,
  requiredTrue,
  roleGrantBody,
  roleGrantValidator,
  tenantPath,
} from "./shared.js";

export type IamTenantGroupCreateResult = {
  tenantId: string;
  groupId: string;
  created: true;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamTenantGroupWriteResult = IamTenantWriteResult & {
  groupId: string;
};

export type IamTenantGroupStatusResult = IamTenantGroupWriteResult & {
  previousStatus: IamPrincipalStatus;
  status: IamPrincipalStatus;
};

export type IamTenantGroupUpdateResult = IamTenantGroupWriteResult | IamTenantGroupStatusResult;

export type IamTenantGroupMemberResult = IamTenantGroupWriteResult & {
  userId: string;
  membershipId?: string;
};

export type IamTenantGroupRolesResult = IamTenantGroupWriteResult & {
  grants: IamRoleGrant[];
};

export type IamTenantGroupPermissionOverridesResult = {
  tenantId: string;
  groupId: string;
  grants: IamPermissionGrant[];
};

export type IamTenantGroupPermissionOverridesWriteResult = IamTenantGroupWriteResult & {
  grants: IamPermissionGrant[];
};

type UpdateGroupInput = {
  tenantId: string;
  groupId: string;
} & ({ action: "rename"; name: string } | { action: "suspend" } | { action: "activate" });

export function createGroupActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    createGroup: builder({
      args: {
        tenantId: v.string(),
        name: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call("post", tenantPath(args.tenantId, "groups"), headersFor(args), {
          name: args.name,
        });
        return {
          tenantId: requiredString(result, "tenant_id", "tenantId"),
          groupId: requiredString(result, "group_id", "groupId"),
          created: requiredTrue(result, "created", "created"),
          sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
          projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
        } satisfies IamTenantGroupCreateResult;
      },
    }),

    updateGroup: builder({
      args: v.union(
        v.object({
          tenantId: v.string(),
          groupId: v.string(),
          action: v.literal("rename"),
          name: v.string(),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          groupId: v.string(),
          action: v.literal("suspend"),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          groupId: v.string(),
          action: v.literal("activate"),
          ...actorValidators,
        }),
      ),
      handler: async (_ctx, args) => {
        const input = args as unknown as UpdateGroupInput;
        return normalizeGroupUpdateResult(
          await call(
            "patch",
            tenantPath(input.tenantId, "groups", input.groupId),
            headersFor(args),
            input.action === "rename"
              ? { action: input.action, name: input.name }
              : { action: input.action },
          ),
        );
      },
    }),

    archiveGroup: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGroupWriteResult(
          await call("delete", tenantPath(args.tenantId, "groups", args.groupId), headersFor(args)),
        ),
    }),

    addGroupMember: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        userId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGroupMemberResult(
          await call(
            "put",
            tenantPath(args.tenantId, "groups", args.groupId, "members", args.userId),
            headersFor(args),
          ),
        ),
    }),

    removeGroupMember: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        userId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGroupMemberResult(
          await call(
            "delete",
            tenantPath(args.tenantId, "groups", args.groupId, "members", args.userId),
            headersFor(args),
          ),
        ),
    }),

    replaceGroupRoles: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        grants: v.array(roleGrantValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "put",
          tenantPath(args.tenantId, "groups", args.groupId, "roles"),
          headersFor(args),
          {
            grants: (args.grants as unknown as IamRoleGrantInput[]).map(roleGrantBody),
          },
        );
        return {
          ...normalizeGroupWriteResult(result),
          grants: requiredRecordArray(result, "grants", "grants").map((record) => {
            const grant = normalizeGrant(record);
            if (grant.type !== "role") {
              throw new Error("IAM API response has invalid group role grant.");
            }
            return grant;
          }),
        } satisfies IamTenantGroupRolesResult;
      },
    }),

    listGroupPermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGroupPermissionOverrides(
          await call(
            "get",
            tenantPath(args.tenantId, "groups", args.groupId, "permission-overrides"),
            headersFor(args),
          ),
        ),
    }),

    replaceGroupPermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        groupId: v.string(),
        overrides: v.array(permissionGrantValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "put",
          tenantPath(args.tenantId, "groups", args.groupId, "permission-overrides"),
          headersFor(args),
          {
            overrides: (args.overrides as unknown as IamPermissionGrantInput[]).map(
              permissionGrantBody,
            ),
          },
        );
        return {
          ...normalizeGroupWriteResult(result),
          grants: requiredRecordArray(result, "grants", "grants").map(normalizePermissionGrant),
        } satisfies IamTenantGroupPermissionOverridesWriteResult;
      },
    }),
  };
}

function normalizeGroupUpdateResult(
  result: import("./shared.js").ApiRecord,
): IamTenantGroupUpdateResult {
  const base = normalizeGroupWriteResult(result);
  if ("previous_status" in result || "status" in result) {
    return {
      ...base,
      previousStatus: requiredPrincipalStatus(result, "previous_status", "previousStatus"),
      status: requiredPrincipalStatus(result, "status", "status"),
    };
  }
  return base;
}

function normalizeGroupWriteResult(
  result: import("./shared.js").ApiRecord,
): IamTenantGroupWriteResult {
  return {
    ...normalizeTenantWriteResult(result),
    groupId: requiredString(result, "group_id", "groupId"),
  };
}

function normalizeGroupMemberResult(
  result: import("./shared.js").ApiRecord,
): IamTenantGroupMemberResult {
  return {
    ...normalizeGroupWriteResult(result),
    userId: requiredString(result, "user_id", "userId"),
    membershipId: optionalString(result, "membership_id", "membershipId"),
  };
}

function normalizeGroupPermissionOverrides(
  result: import("./shared.js").ApiRecord,
): IamTenantGroupPermissionOverridesResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    groupId: requiredString(result, "group_id", "groupId"),
    grants: requiredRecordArray(result, "grants", "grants").map(normalizePermissionGrant),
  };
}

function normalizePermissionGrant(result: import("./shared.js").ApiRecord): IamPermissionGrant {
  const grant = normalizeGrant(result);
  if (grant.type !== "permission") {
    throw new Error("IAM API response has invalid permission grant.");
  }
  return grant;
}
