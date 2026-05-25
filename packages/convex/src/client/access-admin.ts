"use node";

import { Hercules } from "@usehercules/sdk";
import type { ActionBuilder, GenericDataModel } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { AccessActionBuilder } from "./index";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_ACCESS_ADMIN_API_KEY_ENV_VAR = "HERCULES_ACCESS_CONTROL_API_KEY";

type WriteResult = Record<string, unknown>;

export type AccessAdminSdkClient = {
  post<T>(path: string, options: { body: Record<string, unknown> }): Promise<T>;
  accessControl?: {
    scopes?: {
      create?(input: Record<string, unknown>): Promise<WriteResult>;
      archive?(input: Record<string, unknown>): Promise<WriteResult>;
    };
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

type AccessAdminApiOptions = {
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: AccessAdminSdkClient;
};

export type CreateAccessAdminActionsOptions<DataModel extends GenericDataModel> =
  AccessAdminApiOptions & {
    accessAction: AccessActionBuilder<DataModel>;
  };

type CreateScopeArgs = {
  name: string;
  defaultRoleKey?: string;
  accountEntryMode?: "open" | "allowlisted_only";
};

type CreateScopeAuthorizationContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null>;
  };
};

export type CreateAccessScopeActionOptions<DataModel extends GenericDataModel> =
  AccessAdminApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    canCreateScope: (
      ctx: CreateScopeAuthorizationContext,
      args: CreateScopeArgs,
    ) => boolean | Promise<boolean>;
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
    archiveScope: accessAction({
      permission: "access.manage",
      extractScope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId };
        return await callAccessControlApi(
          "/v1/access-control/scopes/archive",
          body,
          (client) => client.scopes?.archive?.(body),
        );
      },
    }),

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

export function createAccessScopeAction<DataModel extends GenericDataModel>(
  options: CreateAccessScopeActionOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);

  return options.authenticatedAction({
    args: {
      name: v.string(),
      defaultRoleKey: v.optional(v.string()),
      accountEntryMode: v.optional(v.union(v.literal("open"), v.literal("allowlisted_only"))),
    },
    handler: async (ctx, args) => {
      const allowed = await options.canCreateScope(ctx, args);
      if (!allowed) {
        throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
      }

      const identity = await ctx.auth.getUserIdentity();
      const actorHerculesAuthUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
      const body = {
        name: args.name,
        default_role_key: args.defaultRoleKey,
        account_entry_mode: args.accountEntryMode,
        actor_hercules_auth_user_id: actorHerculesAuthUserId,
      };
      return await callAccessControlApi(
        "/v1/access-control/scopes/create",
        body,
        (client) => client.scopes?.create?.(body),
      );
    },
  });
}

function makeAccessControlApiCaller(options: AccessAdminApiOptions) {
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

function createSdkClient(options: AccessAdminApiOptions): AccessAdminSdkClient {
  const envVarName = options.apiKeyEnvVar ?? DEFAULT_ACCESS_ADMIN_API_KEY_ENV_VAR;
  const apiKey = options.apiKey ?? process.env[envVarName];
  if (!apiKey) {
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

function parseTokenIdentifierSubject(tokenIdentifier: string | null | undefined): string {
  if (!tokenIdentifier) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  return tokenIdentifier.slice(separatorIndex + 1);
}
