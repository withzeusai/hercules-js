import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  compactBody,
  grantableRoleTargetBody,
  grantableRoleTargetValidator,
  type IamActionModuleContext,
  type IamGrantableRoleTarget,
  type IamPermissionOverride,
  type IamTenantWriteResult,
  normalizeTenantWriteResult,
  optionalStringArray,
  permissionOverrideBody,
  permissionOverrideValidator,
  requiredBoolean,
  requiredEffect,
  requiredNumber,
  requiredRecordArray,
  requiredRoleKind,
  requiredString,
  requiredStringArray,
  requiredTrue,
  tenantPath,
} from "./shared.js";

export type IamTenantRoleCreateResult = {
  tenantId: string;
  roleId: string;
  roleKey: string;
  permissionKeys: string[];
  created: true;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamTenantRoleUpdateResult = IamTenantWriteResult & {
  roleId: string;
  permissionKeys?: string[];
};

export type IamTenantRoleWriteResult = IamTenantWriteResult & {
  roleId: string;
};

export type IamGrantableRoleListResult = {
  tenantId: string;
  roles: Array<{
    roleId: string;
    roleKey: string;
    roleName: string;
    roleKind: "system" | "custom";
    shared: boolean;
  }>;
};

export type IamTenantRolePermissionOverridesResult = {
  tenantId: string;
  roleId: string;
  overrides: Array<
    IamPermissionOverride & {
      permissionId: string;
    }
  >;
};

type IamTenantRoleUpdateInput = {
  tenantId: string;
  roleId: string;
  name?: string;
  description?: string | null;
  permissionKeys?: string[];
};

export function createRoleActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    createRole: builder({
      args: {
        tenantId: v.string(),
        key: v.string(),
        name: v.string(),
        description: v.optional(v.union(v.string(), v.null())),
        permissionKeys: v.optional(v.array(v.string())),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "post",
          tenantPath(args.tenantId, "roles"),
          headersFor(args),
          compactBody({
            key: args.key,
            name: args.name,
            description: args.description,
            permission_keys: args.permissionKeys,
          }),
        );
        return {
          tenantId: requiredString(result, "tenant_id", "tenantId"),
          roleId: requiredString(result, "role_id", "roleId"),
          roleKey: requiredString(result, "role_key", "roleKey"),
          permissionKeys: requiredStringArray(result, "permission_keys", "permissionKeys"),
          created: requiredTrue(result, "created", "created"),
          sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
          projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
        } satisfies IamTenantRoleCreateResult;
      },
    }),

    updateRole: builder({
      args: v.union(
        v.object({
          tenantId: v.string(),
          roleId: v.string(),
          name: v.string(),
          description: v.optional(v.union(v.string(), v.null())),
          permissionKeys: v.optional(v.array(v.string())),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          roleId: v.string(),
          name: v.optional(v.string()),
          description: v.union(v.string(), v.null()),
          permissionKeys: v.optional(v.array(v.string())),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          roleId: v.string(),
          name: v.optional(v.string()),
          description: v.optional(v.union(v.string(), v.null())),
          permissionKeys: v.array(v.string()),
          ...actorValidators,
        }),
      ),
      handler: async (_ctx, args) => {
        const input = args as unknown as IamTenantRoleUpdateInput;
        const result = await call(
          "patch",
          tenantPath(input.tenantId, "roles", input.roleId),
          headersFor(args),
          compactBody({
            name: input.name,
            description: input.description,
            permission_keys: input.permissionKeys,
          }),
        );
        return {
          ...normalizeRoleWriteResult(result),
          permissionKeys: optionalStringArray(result, "permission_keys", "permissionKeys"),
        } satisfies IamTenantRoleUpdateResult;
      },
    }),

    archiveRole: builder({
      args: {
        tenantId: v.string(),
        roleId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeRoleWriteResult(
          await call("delete", tenantPath(args.tenantId, "roles", args.roleId), headersFor(args)),
        ),
    }),

    evaluateGrantableRoles: builder({
      args: {
        tenantId: v.string(),
        subjectType: v.union(v.literal("user"), v.literal("group")),
        target: grantableRoleTargetValidator,
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGrantableRolesResult(
          await call(
            "post",
            tenantPath(args.tenantId, "roles", "evaluate-grantability"),
            headersFor(args),
            {
              subject_type: args.subjectType,
              target: grantableRoleTargetBody(args.target as IamGrantableRoleTarget),
            },
          ),
        ),
    }),

    listRolePermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        roleId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeRolePermissionOverrides(
          await call(
            "get",
            tenantPath(args.tenantId, "roles", args.roleId, "permission-overrides"),
            headersFor(args),
          ),
        ),
    }),

    replaceRolePermissionOverrides: builder({
      args: {
        tenantId: v.string(),
        roleId: v.string(),
        overrides: v.array(permissionOverrideValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeRoleWriteResult(
          await call(
            "put",
            tenantPath(args.tenantId, "roles", args.roleId, "permission-overrides"),
            headersFor(args),
            { overrides: args.overrides.map(permissionOverrideBody) },
          ),
        ),
    }),
  };
}

function normalizeRoleWriteResult(
  result: import("./shared.js").ApiRecord,
): IamTenantRoleWriteResult {
  return {
    ...normalizeTenantWriteResult(result),
    roleId: requiredString(result, "role_id", "roleId"),
  };
}

function normalizeGrantableRolesResult(
  result: import("./shared.js").ApiRecord,
): IamGrantableRoleListResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    roles: requiredRecordArray(result, "roles", "roles").map((role) => ({
      roleId: requiredString(role, "role_id", "roles[].roleId"),
      roleKey: requiredString(role, "role_key", "roles[].roleKey"),
      roleName: requiredString(role, "role_name", "roles[].roleName"),
      roleKind: requiredRoleKind(role, "role_kind", "roles[].roleKind"),
      shared: requiredBoolean(role, "shared", "roles[].shared"),
    })),
  };
}

function normalizeRolePermissionOverrides(
  result: import("./shared.js").ApiRecord,
): IamTenantRolePermissionOverridesResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    roleId: requiredString(result, "role_id", "roleId"),
    overrides: requiredRecordArray(result, "overrides", "overrides").map((override) => ({
      permissionId: requiredString(override, "permission_id", "overrides[].permissionId"),
      permissionKey: requiredString(override, "permission_key", "overrides[].permissionKey"),
      effect: requiredEffect(override, "effect", "overrides[].effect"),
    })),
  };
}
