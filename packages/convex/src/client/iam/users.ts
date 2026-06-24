import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  compactBody,
  type IamActionModuleContext,
  type IamPermissionGrant,
  type IamPermissionGrantInput,
  type IamPrincipalStatus,
  type IamRoleGrant,
  type IamRoleGrantInput,
  type IamTenantWriteResult,
  normalizeGrant,
  normalizeTenantWriteResult,
  permissionGrantBody,
  permissionGrantValidator,
  requiredPrincipalStatus,
  requiredRecord,
  requiredRecordArray,
  requiredString,
  roleGrantBody,
  roleGrantValidator,
  tenantPath,
  userActionValidator,
} from "./shared.js";

export type IamTenantUserCreateResult = IamTenantWriteResult & {
  userId: string;
  grant: IamRoleGrant;
};

export type IamTenantUserUpdateResult = IamTenantWriteResult & {
  userId: string;
  previousStatus: IamPrincipalStatus;
  status: IamPrincipalStatus;
};

export type IamTenantUserWriteResult = IamTenantWriteResult & {
  userId: string;
};

export type IamTenantUserRolesResult = IamTenantUserWriteResult & {
  grants: IamRoleGrant[];
};

export type IamTenantUserPermissionOverridesResult = {
  tenantId: string;
  userId: string;
  grants: IamPermissionGrant[];
};

export type IamTenantUserPermissionOverridesWriteResult = IamTenantUserWriteResult & {
  grants: IamPermissionGrant[];
};

export function createUserActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    createUser: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        grant: v.optional(roleGrantValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "post",
          tenantPath(args.tenantId, "users"),
          headersFor(args),
          compactBody({
            user_id: args.userId,
            grant: args.grant
              ? roleGrantBody(args.grant as unknown as IamRoleGrantInput)
              : undefined,
          }),
        );
        return {
          ...normalizeTenantWriteResult(result),
          userId: requiredString(result, "user_id", "userId"),
          grant: normalizeRoleGrant(requiredRecord(result, "grant", "grant")),
        } satisfies IamTenantUserCreateResult;
      },
    }),

    updateUser: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        action: userActionValidator,
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "patch",
          tenantPath(args.tenantId, "users", args.userId),
          headersFor(args),
          { action: args.action },
        );
        return {
          ...normalizeTenantWriteResult(result),
          userId: requiredString(result, "user_id", "userId"),
          previousStatus: requiredPrincipalStatus(result, "previous_status", "previousStatus"),
          status: requiredPrincipalStatus(result, "status", "status"),
        } satisfies IamTenantUserUpdateResult;
      },
    }),

    removeUser: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "delete",
          tenantPath(args.tenantId, "users", args.userId),
          headersFor(args),
        );
        return normalizeUserWriteResult(result);
      },
    }),

    replaceUserRoles: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        grants: v.array(roleGrantValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "put",
          tenantPath(args.tenantId, "users", args.userId, "roles"),
          headersFor(args),
          {
            grants: (args.grants as unknown as IamRoleGrantInput[]).map(roleGrantBody),
          },
        );
        return {
          ...normalizeUserWriteResult(result),
          grants: requiredRecordArray(result, "grants", "grants").map((grant) =>
            normalizeRoleGrant(grant),
          ),
        } satisfies IamTenantUserRolesResult;
      },
    }),

    listUserPermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeUserPermissionOverrides(
          await call(
            "get",
            tenantPath(args.tenantId, "users", args.userId, "permission-overrides"),
            headersFor(args),
          ),
        ),
    }),

    replaceUserPermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        userId: v.string(),
        overrides: v.array(permissionGrantValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "put",
          tenantPath(args.tenantId, "users", args.userId, "permission-overrides"),
          headersFor(args),
          {
            overrides: (args.overrides as unknown as IamPermissionGrantInput[]).map(
              permissionGrantBody,
            ),
          },
        );
        return {
          ...normalizeUserWriteResult(result),
          grants: requiredRecordArray(result, "grants", "grants").map((grant) =>
            normalizePermissionGrant(grant),
          ),
        } satisfies IamTenantUserPermissionOverridesWriteResult;
      },
    }),
  };
}

function normalizeUserWriteResult(
  result: import("./shared.js").ApiRecord,
): IamTenantUserWriteResult {
  return {
    ...normalizeTenantWriteResult(result),
    userId: requiredString(result, "user_id", "userId"),
  };
}

function normalizeUserPermissionOverrides(
  result: import("./shared.js").ApiRecord,
): IamTenantUserPermissionOverridesResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    userId: requiredString(result, "user_id", "userId"),
    grants: requiredRecordArray(result, "grants", "grants").map((grant) =>
      normalizePermissionGrant(grant),
    ),
  };
}

function normalizeRoleGrant(result: import("./shared.js").ApiRecord): IamRoleGrant {
  const grant = normalizeGrant(result);
  if (grant.type !== "role") throw new Error("IAM API response has invalid role grant.");
  return grant;
}

function normalizePermissionGrant(result: import("./shared.js").ApiRecord): IamPermissionGrant {
  const grant = normalizeGrant(result);
  if (grant.type !== "permission") {
    throw new Error("IAM API response has invalid permission grant.");
  }
  return grant;
}
