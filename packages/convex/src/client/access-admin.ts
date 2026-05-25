"use node";

import { Hercules } from "@usehercules/sdk";
import type { GenericDataModel } from "convex/server";
import { v } from "convex/values";
import type { AccessActionBuilder } from "./index";

const DEFAULT_API_VERSION = "2025-12-09";

type WriteResult = Record<string, unknown>;

export type AccessAdminSdkClient = {
  post<T>(path: string, options: { body: Record<string, unknown> }): Promise<T>;
  accessControl?: {
    roles?: {
      assign?(input: Record<string, unknown>): Promise<WriteResult>;
      remove?(input: Record<string, unknown>): Promise<WriteResult>;
      createOrgCustom?(input: Record<string, unknown>): Promise<WriteResult>;
      updatePermissions?(input: Record<string, unknown>): Promise<WriteResult>;
    };
    userExceptions?: {
      set?(input: Record<string, unknown>): Promise<WriteResult>;
    };
    resourceGrants?: {
      create?(input: Record<string, unknown>): Promise<WriteResult>;
      revoke?(input: Record<string, unknown>): Promise<WriteResult>;
    };
    expiries?: {
      set?(input: Record<string, unknown>): Promise<WriteResult>;
    };
    roleOverrides?: {
      set?(input: Record<string, unknown>): Promise<WriteResult>;
    };
  };
};

export type CreateAccessAdminActionsOptions<DataModel extends GenericDataModel> = {
  accessAction: AccessActionBuilder<DataModel>;
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: AccessAdminSdkClient;
};

const optionalPrincipalRef = {
  principalId: v.optional(v.string()),
  herculesAuthUserId: v.optional(v.string()),
};

const optionalRoleRef = {
  roleId: v.optional(v.string()),
  roleKey: v.optional(v.string()),
};

export function createAccessAdminActions<DataModel extends GenericDataModel>(
  options: CreateAccessAdminActionsOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const { accessAction } = options;

  return {
    assignRole: accessAction({
      permission: "access.users.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          ...roleRef(args),
        };
        return await callAccessControlApi(
          "/v1/access-control/roles/assign",
          body,
          (client) => client.roles?.assign?.(body),
        );
      },
    }),

    removeRole: accessAction({
      permission: "access.users.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          ...roleRef(args),
        };
        return await callAccessControlApi(
          "/v1/access-control/roles/remove",
          body,
          (client) => client.roles?.remove?.(body),
        );
      },
    }),

    createOrgCustomRole: accessAction({
      permission: "access.roles.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        key: v.optional(v.string()),
        name: v.string(),
        description: v.optional(v.string()),
        permissionKeys: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          key: args.key,
          name: args.name,
          description: args.description,
          permission_keys: args.permissionKeys,
        };
        return await callAccessControlApi(
          "/v1/access-control/roles/create-org-custom",
          body,
          (client) => client.roles?.createOrgCustom?.(body),
        );
      },
    }),

    updateRolePermissions: accessAction({
      permission: "access.roles.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalRoleRef,
        permissionKeys: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          permission_keys: args.permissionKeys,
        };
        return await callAccessControlApi(
          "/v1/access-control/roles/update-permissions",
          body,
          (client) => client.roles?.updatePermissions?.(body),
        );
      },
    }),

    setUserExceptions: accessAction({
      permission: "access.users.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        allow: v.array(v.string()),
        deny: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          allow: args.allow,
          deny: args.deny,
        };
        return await callAccessControlApi(
          "/v1/access-control/user-exceptions/set",
          body,
          (client) => client.userExceptions?.set?.(body),
        );
      },
    }),

    createResourceGrant: accessAction({
      permission: "access.grants.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        resourceType: v.string(),
        resourceId: v.string(),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          expires_at: args.expiresAt,
        };
        return await callAccessControlApi(
          "/v1/access-control/resource-grants/create",
          body,
          (client) => client.resourceGrants?.create?.(body),
        );
      },
    }),

    revokeResourceGrant: accessAction({
      permission: "access.grants.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        grantId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, grant_id: args.grantId };
        return await callAccessControlApi(
          "/v1/access-control/resource-grants/revoke",
          body,
          (client) => client.resourceGrants?.revoke?.(body),
        );
      },
    }),

    setGrantExpiry: accessAction({
      permission: "access.grants.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        grantId: v.string(),
        expiresAt: v.union(v.string(), v.null()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          grant_id: args.grantId,
          expires_at: args.expiresAt,
        };
        return await callAccessControlApi(
          "/v1/access-control/expiries/set",
          body,
          (client) => client.expiries?.set?.(body),
        );
      },
    }),

    setRoleOverride: accessAction({
      permission: "access.roles.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        roleKey: v.string(),
        allow: v.array(v.string()),
        deny: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          role_key: args.roleKey,
          allow: args.allow,
          deny: args.deny,
        };
        return await callAccessControlApi(
          "/v1/access-control/role-overrides/set",
          body,
          (client) => client.roleOverrides?.set?.(body),
        );
      },
    }),
  };
}

function makeAccessControlApiCaller<DataModel extends GenericDataModel>(
  options: CreateAccessAdminActionsOptions<DataModel>,
) {
  let client: AccessAdminSdkClient | undefined = options.client;

  return async (
    path: string,
    body: Record<string, unknown>,
    generatedCall: (
      client: NonNullable<AccessAdminSdkClient["accessControl"]>,
    ) => Promise<WriteResult> | undefined,
  ): Promise<WriteResult> => {
    client ??= createSdkClient(options);
    const generatedResult = client.accessControl ? generatedCall(client.accessControl) : undefined;
    if (generatedResult) return await generatedResult;
    return await client.post<WriteResult>(path, { body });
  };
}

function createSdkClient<DataModel extends GenericDataModel>(
  options: CreateAccessAdminActionsOptions<DataModel>,
): AccessAdminSdkClient {
  const apiKey = options.apiKey ?? process.env[options.apiKeyEnvVar ?? "HERCULES_API_KEY"];
  if (!apiKey) {
    const envVarName = options.apiKeyEnvVar ?? "HERCULES_API_KEY";
    throw new Error(`${envVarName} is required for Access Control admin actions.`);
  }

  return new Hercules({
    apiKey,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  }) as unknown as AccessAdminSdkClient;
}

function principalRef(args: { principalId?: string; herculesAuthUserId?: string }) {
  return {
    principal_id: args.principalId,
    hercules_auth_user_id: args.herculesAuthUserId,
  };
}

function roleRef(args: { roleId?: string; roleKey?: string }) {
  return {
    role_id: args.roleId,
    role_key: args.roleKey,
  };
}
