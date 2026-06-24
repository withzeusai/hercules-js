import type { ActionBuilder, GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, type PropertyValidators, v } from "convex/values";
import type { IamDeploymentEntryMirrorResult } from "../index.js";
import {
  accountEntryModeValidator,
  userActorHeaders,
  compactBody,
  type IamAccountEntryMode,
  type IamActionModuleContext,
  type IamApiOptions,
  type IamRoleReference,
  type IamTenantWriteResult,
  makeIamApiCaller,
  normalizeTenantWriteResult,
  optionalEntryMode,
  optionalNullableString,
  optionalPrincipalStatus,
  optionalString,
  parseTokenIdentifierSubject,
  requiredBoolean,
  requiredNumber,
  requiredString,
  requiredStringArray,
  requiredTrue,
  roleReferenceBody,
  roleReferenceValidator,
  serviceActorHeaders,
  tenantPath,
} from "./shared.js";

export type IamTenantCreateResult = {
  tenantId: string;
  created: true;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamTenantUpdateResult = IamTenantWriteResult & {
  previousName?: string;
  name?: string;
  previousDefaultRoleId?: string | null;
  defaultRoleId?: string;
  previousEntryMode?: IamAccountEntryMode;
  entryMode?: IamAccountEntryMode;
};

export type IamDeploymentEntryResult = {
  tenantId?: string;
  userId?: string;
  allowed: boolean;
  reason: string;
  status?: import("./shared.js").IamPrincipalStatus;
  stateVersion: number;
  changed: boolean;
};

export type CreateIamTenantArgs = {
  name: string;
  defaultRole?: IamRoleReference;
  entryMode?: IamAccountEntryMode;
};

type IamTenantUpdateInput = {
  tenantId: string;
  name?: string;
  defaultRole?: IamRoleReference;
  entryMode?: IamAccountEntryMode;
};

export type CreateIamTenantContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null>;
  };
};

export type CreateIamTenantActionOptions<DataModel extends GenericDataModel> = IamApiOptions & {
  authenticatedAction: ActionBuilder<DataModel, "public">;
  canCreateTenant: (
    ctx: CreateIamTenantContext,
    args: CreateIamTenantArgs,
  ) => boolean | Promise<boolean>;
};

export type CreateDeploymentEntryActionOptions<DataModel extends GenericDataModel> =
  IamApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    getDeploymentEntryStatus?: (
      ctx: GenericActionCtx<DataModel>,
    ) => Promise<IamDeploymentEntryMirrorResult>;
  };

export function createTenantActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    updateTenant: builder({
      args: v.union(
        v.object({
          tenantId: v.string(),
          name: v.string(),
          defaultRole: v.optional(roleReferenceValidator),
          entryMode: v.optional(accountEntryModeValidator),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          name: v.optional(v.string()),
          defaultRole: roleReferenceValidator,
          entryMode: v.optional(accountEntryModeValidator),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          name: v.optional(v.string()),
          defaultRole: v.optional(roleReferenceValidator),
          entryMode: accountEntryModeValidator,
          ...actorValidators,
        }),
      ),
      handler: async (_ctx, args) => {
        const input = args as unknown as IamTenantUpdateInput;
        const result = await call(
          "patch",
          tenantPath(input.tenantId),
          headersFor(args),
          compactBody({
            name: input.name,
            default_role: input.defaultRole ? roleReferenceBody(input.defaultRole) : undefined,
            entry_mode: input.entryMode,
          }),
        );
        return normalizeTenantUpdateResult(result);
      },
    }),
  };
}

export function createArchiveTenantAction<DataModel extends GenericDataModel>(
  builder: ActionBuilder<DataModel, "internal">,
  options: IamApiOptions,
) {
  const call = makeIamApiCaller(options);
  return builder({
    args: { tenantId: v.string() },
    handler: async (_ctx, args) =>
      normalizeTenantWriteResult(
        await call("delete", tenantPath(args.tenantId), serviceActorHeaders()),
      ),
  });
}

export function createEvaluateTenantEntryAction<DataModel extends GenericDataModel>(
  builder: ActionBuilder<DataModel, "public">,
  options: IamApiOptions,
) {
  const call = makeIamApiCaller(options);
  return builder({
    args: { tenantId: v.string(), idToken: v.string() },
    handler: async (_ctx, args) =>
      normalizeDeploymentEntryResult(
        await call("post", tenantPath(args.tenantId, "entry"), userActorHeaders(args.idToken), {}),
      ),
  });
}

export function createDeploymentEntryAction<DataModel extends GenericDataModel>(
  options: CreateDeploymentEntryActionOptions<DataModel>,
) {
  const call = makeIamApiCaller(options);

  return options.authenticatedAction({
    args: { idToken: v.string() },
    handler: async (ctx, args) => {
      if (options.getDeploymentEntryStatus) {
        const mirror = await options.getDeploymentEntryStatus(ctx);
        if (mirror.kind === "principal" && mirror.status === "active") {
          return activeDeploymentEntryResultFromMirror(mirror);
        }
      }
      return normalizeDeploymentEntryResult(
        await call("post", tenantPath("default", "entry"), userActorHeaders(args.idToken), {}),
      );
    },
  });
}

export function createIamTenantAction<DataModel extends GenericDataModel>(
  options: CreateIamTenantActionOptions<DataModel>,
) {
  return options.authenticatedAction({
    args: {
      name: v.string(),
      defaultRole: v.optional(roleReferenceValidator),
      entryMode: v.optional(accountEntryModeValidator),
    },
    handler: async (ctx, args) => {
      if (!(await options.canCreateTenant(ctx, args))) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Access denied",
        });
      }
      return await createIamTenant(ctx, args, options);
    },
  });
}

export async function createIamTenant(
  ctx: CreateIamTenantContext,
  args: CreateIamTenantArgs,
  options: IamApiOptions = {},
): Promise<IamTenantCreateResult> {
  const identity = await ctx.auth.getUserIdentity();
  const ownerUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
  const call = makeIamApiCaller(options);
  const result = await call(
    "post",
    "/v1/iam/tenants",
    serviceActorHeaders(),
    compactBody({
      name: args.name,
      owner_user_id: ownerUserId,
      default_role: args.defaultRole ? roleReferenceBody(args.defaultRole) : undefined,
      entry_mode: args.entryMode,
    }),
  );
  return normalizeTenantCreateResult(result);
}

function normalizeTenantCreateResult(
  result: import("./shared.js").ApiRecord,
): IamTenantCreateResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    created: requiredTrue(result, "created", "created"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeTenantUpdateResult(
  result: import("./shared.js").ApiRecord,
): IamTenantUpdateResult {
  return {
    ...normalizeTenantWriteResult(result),
    previousName: optionalString(result, "previous_name", "previousName"),
    name: optionalString(result, "name", "name"),
    previousDefaultRoleId: optionalNullableString(
      result,
      "previous_default_role_id",
      "previousDefaultRoleId",
    ),
    defaultRoleId: optionalString(result, "default_role_id", "defaultRoleId"),
    previousEntryMode: optionalEntryMode(result, "previous_entry_mode", "previousEntryMode"),
    entryMode: optionalEntryMode(result, "entry_mode", "entryMode"),
  };
}

function normalizeDeploymentEntryResult(
  result: import("./shared.js").ApiRecord,
): IamDeploymentEntryResult {
  return {
    tenantId: optionalString(result, "tenant_id", "tenantId"),
    userId: optionalString(result, "user_id", "userId"),
    allowed: requiredBoolean(result, "allowed", "allowed"),
    reason: requiredString(result, "reason", "reason"),
    status: optionalPrincipalStatus(result, "status", "status"),
    stateVersion: requiredNumber(result, "state_version", "stateVersion"),
    changed: requiredBoolean(result, "changed", "changed"),
  };
}

function activeDeploymentEntryResultFromMirror(result: {
  principalId: string;
  stateVersion: number;
}): IamDeploymentEntryResult {
  return {
    allowed: true,
    reason: "existing_active",
    status: "active",
    stateVersion: result.stateVersion,
    changed: false,
  };
}
