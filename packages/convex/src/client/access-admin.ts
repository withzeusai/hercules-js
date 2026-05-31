"use node";

import { Hercules } from "@usehercules/sdk";
import type { ActionBuilder, GenericDataModel } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { AccessActionBuilder } from "./index";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_ACCESS_ADMIN_API_KEY_ENV_VAR = "HERCULES_API_KEY";

type WriteResult = Record<string, unknown>;

export type AccessScopeCreateResult = {
  accessScopeId: string;
  accessScopeAppId?: string;
  created?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessInvitationCreateResult = {
  accessScopeId: string;
  invitationId: string;
  email: string;
  roleIds: string[];
  token: string;
  acceptUrl: string;
  expiresAt: string;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessInvitationAcceptResult = {
  accessScopeId: string;
  invitationId: string;
  principalId: string;
  roleIds: string[];
  changed?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessAdminSdkClient = {
  post<T>(path: string, options: { body: Record<string, unknown> }): Promise<T>;
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

export type CreateAccessScopeArgs = {
  name: string;
  defaultRoleKey?: string;
  accountEntryMode?: "open" | "allowlisted_only";
};

export type CreateAccessInvitationArgs = {
  scopeId: string;
  email: string;
  roleIds?: string[];
  roleKeys?: string[];
  expiresInDays?: number;
};

export type AcceptAccessInvitationArgs = { token: string; idToken: string };

export type CreateAccessScopeContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null>;
  };
};

export type CreateAccessScopeActionOptions<DataModel extends GenericDataModel> =
  AccessAdminApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    canCreateScope: (
      ctx: CreateAccessScopeContext,
      args: CreateAccessScopeArgs,
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
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId };
        return await callAccessControlApi("/v1/access-control/scopes/archive", body);
      },
    }),

    setDefaultRole: accessAction({
      permission: "access.roles.manage",
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
        };
        return await callAccessControlApi("/v1/access-control/scopes/set-default-role", body);
      },
    }),

    createInvitation: accessAction({
      permission: "access.users.manage",
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        email: v.string(),
        roleIds: v.optional(v.array(v.string())),
        roleKeys: v.optional(v.array(v.string())),
        expiresInDays: v.optional(v.number()),
      },
      handler: async (_ctx, args) => {
        const result = await createAccessInvitation(args, options);
        return result;
      },
    }),

    revokeInvitation: accessAction({
      permission: "access.users.manage",
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        invitationId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, invitation_id: args.invitationId };
        return await callAccessControlApi("/v1/access-control/invitations/revoke", body);
      },
    }),

    assignRole: accessAction({
      permission: "access.users.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/roles/assign", body);
      },
    }),

    removeRole: accessAction({
      permission: "access.users.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/roles/remove", body);
      },
    }),

    createOrgCustomRole: accessAction({
      permission: "access.roles.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/roles/create-org-custom", body);
      },
    }),

    updateRolePermissions: accessAction({
      permission: "access.roles.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/roles/update-permissions", body);
      },
    }),

    setUserExceptions: accessAction({
      permission: "access.users.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/user-exceptions/set", body);
      },
    }),

    createResourceGrant: accessAction({
      permission: "access.grants.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/resource-grants/create", body);
      },
    }),

    setResourcePermissionRule: accessAction({
      permission: "access.grants.manage",
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        subject: v.union(
          v.object({ type: v.literal("principal"), principalId: v.string() }),
          v.object({ type: v.literal("role"), roleKey: v.string() }),
        ),
        resourceType: v.string(),
        target: v.union(
          v.object({ mode: v.literal("all") }),
          v.object({ mode: v.literal("specific"), resourceId: v.string() }),
        ),
        permissionKey: v.string(),
        effect: v.union(v.literal("allow"), v.literal("deny")),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          subject:
            args.subject.type === "role"
              ? { type: "role", role_key: args.subject.roleKey }
              : { type: "principal", principal_id: args.subject.principalId },
          resource_type: args.resourceType,
          target:
            args.target.mode === "all"
              ? { mode: "all" }
              : { mode: "specific", resource_id: args.target.resourceId },
          permission_key: args.permissionKey,
          effect: args.effect,
          expires_at: args.expiresAt,
        };
        return await callAccessControlApi("/v1/access-control/resource-rules/set", body);
      },
    }),

    revokeResourceGrant: accessAction({
      permission: "access.grants.manage",
      scope: (_ctx, args) => args.scopeId,
      args: {
        scopeId: v.string(),
        grantId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, grant_id: args.grantId };
        return await callAccessControlApi("/v1/access-control/resource-grants/revoke", body);
      },
    }),

    setGrantExpiry: accessAction({
      permission: "access.grants.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/expiries/set", body);
      },
    }),

    setRoleOverride: accessAction({
      permission: "access.roles.manage",
      scope: (_ctx, args) => args.scopeId,
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
        return await callAccessControlApi("/v1/access-control/role-overrides/set", body);
      },
    }),
  };
}

export function createAccessScopeAction<DataModel extends GenericDataModel>(
  options: CreateAccessScopeActionOptions<DataModel>,
) {
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

      return await createAccessScope(ctx, args, options);
    },
  });
}

export async function createAccessScope(
  ctx: CreateAccessScopeContext,
  args: CreateAccessScopeArgs,
  options: AccessAdminApiOptions = {},
): Promise<AccessScopeCreateResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  const actorHerculesAuthUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
  const body = {
    name: args.name,
    default_role_key: args.defaultRoleKey,
    account_entry_mode: args.accountEntryMode,
    actor_hercules_auth_user_id: actorHerculesAuthUserId,
  };
  const result = await callAccessControlApi("/v1/access-control/scopes/create", body);
  return normalizeAccessScopeCreateResult(result);
}

export async function createAccessInvitation(
  args: CreateAccessInvitationArgs,
  options: AccessAdminApiOptions = {},
): Promise<AccessInvitationCreateResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const body = {
    scope_id: args.scopeId,
    email: args.email,
    role_ids: args.roleIds,
    role_keys: args.roleKeys,
    expires_in_days: args.expiresInDays,
  };
  const result = await callAccessControlApi("/v1/access-control/invitations/create", body);
  return normalizeAccessInvitationCreateResult(result);
}

export async function acceptAccessInvitation(
  ctx: CreateAccessScopeContext,
  args: AcceptAccessInvitationArgs,
  options: AccessAdminApiOptions = {},
): Promise<AccessInvitationAcceptResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  requireTokenIdentifier(identity?.tokenIdentifier);
  const body = {
    token: args.token,
    id_token: args.idToken,
  };
  const result = await callAccessControlApi("/v1/access-control/invitations/accept", body);
  return normalizeAccessInvitationAcceptResult(result);
}

function makeAccessControlApiCaller(options: AccessAdminApiOptions) {
  let client: AccessAdminSdkClient | undefined = options.client;

  return async (path: string, body: Record<string, unknown>): Promise<WriteResult> => {
    client ??= createSdkClient(options);
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
  const value = requireTokenIdentifier(tokenIdentifier);
  const separatorIndex = value.lastIndexOf("|");
  return value.slice(separatorIndex + 1);
}

function requireTokenIdentifier(tokenIdentifier: string | null | undefined): string {
  if (!tokenIdentifier) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  return tokenIdentifier;
}

function normalizeAccessScopeCreateResult(result: WriteResult): AccessScopeCreateResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    accessScopeAppId: optionalString(result, "access_scope_app_id", "accessScopeAppId"),
    created: optionalBoolean(result, "created", "created"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeAccessInvitationCreateResult(result: WriteResult): AccessInvitationCreateResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    invitationId: requiredString(result, "invitation_id", "invitationId"),
    email: requiredString(result, "email", "email"),
    roleIds: requiredStringArray(result, "role_ids", "roleIds"),
    token: requiredString(result, "token", "token"),
    acceptUrl: requiredString(result, "accept_url", "acceptUrl"),
    expiresAt: requiredString(result, "expires_at", "expiresAt"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeAccessInvitationAcceptResult(result: WriteResult): AccessInvitationAcceptResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    invitationId: requiredString(result, "invitation_id", "invitationId"),
    principalId: requiredString(result, "principal_id", "principalId"),
    roleIds: requiredStringArray(result, "role_ids", "roleIds"),
    changed: optionalBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function requiredString(result: WriteResult, apiKey: string, resultName: string): string {
  const value = result[apiKey];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Access Control API response missing ${resultName}.`);
  }
  return value;
}

function optionalString(
  result: WriteResult,
  apiKey: string,
  resultName: string,
): string | undefined {
  const value = result[apiKey];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Access Control API response has invalid ${resultName}.`);
  }
  return value;
}

function optionalBoolean(
  result: WriteResult,
  apiKey: string,
  resultName: string,
): boolean | undefined {
  const value = result[apiKey];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Access Control API response has invalid ${resultName}.`);
  }
  return value;
}

function requiredNumber(result: WriteResult, apiKey: string, resultName: string): number {
  const value = result[apiKey];
  if (typeof value !== "number") {
    throw new Error(`Access Control API response missing ${resultName}.`);
  }
  return value;
}

function requiredStringArray(result: WriteResult, apiKey: string, resultName: string): string[] {
  const value = result[apiKey];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Access Control API response missing ${resultName}.`);
  }
  return value;
}
