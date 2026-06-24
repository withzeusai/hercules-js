import type { GenericDataModel } from "convex/server";
import type { ObjectType, PropertyValidators, Validator } from "convex/values";
import { v } from "convex/values";
import type { CreateIamTenantContext } from "./tenants.js";
import {
  appliesToValidator,
  compactBody,
  type IamActionModuleContext,
  type IamApiOptions,
  type IamBindingAppliesTo,
  type IamGrant,
  type IamResourceGrant,
  type IamRoleGrantInput,
  type IamTenantWriteResult,
  makeIamApiCaller,
  normalizeGrant,
  normalizeResourceGrant,
  normalizeTenantWriteResult,
  optionalString,
  queryPath,
  requiredAppliesTo,
  requiredEffect,
  requiredNumber,
  requiredRecord,
  requiredRecordArray,
  requiredString,
  requiredStringArray,
  requireTokenIdentifier,
  roleGrantBody,
  roleGrantValidator,
  resourceInvitationPermissionGrantValidator,
  tenantPath,
  userActorHeaders,
} from "./shared.js";

export type IamInvitationTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      appliesTo: IamBindingAppliesTo;
    };

type IamInvitationBase = {
  invitationId: string;
  email: string;
  expiresAt: string;
};

export type IamInvitationRoleGrant = {
  conferralId: string;
  type: "role";
  roleId: string;
  expiresAt: string | null;
};

export type IamInvitationPermissionGrant = {
  conferralId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow";
  expiresAt: string | null;
};

export type IamInvitationGrant = IamInvitationRoleGrant | IamInvitationPermissionGrant;

export type IamResourceInvitationPermissionGrantInput = {
  permissionKey: string;
  expiresAt?: string | null;
};

export type IamResourceInvitationGrantInput =
  | IamRoleGrantInput
  | IamResourceInvitationPermissionGrantInput;

export type IamInvitationListItem = IamInvitationBase &
  (
    | {
        target: { type: "tenant" };
        grants: IamInvitationRoleGrant[];
      }
    | {
        target: Extract<IamInvitationTarget, { type: "resource" }>;
        grant: IamInvitationGrant;
      }
  );

export type IamInvitationListResult = {
  tenantId: string;
  invitations: Array<
    IamInvitationListItem & {
      createdAt: string;
      updatedAt: string;
    }
  >;
  nextCursor?: string;
};

export type IamInvitationCreateResult = {
  tenantId: string;
  token: string;
  acceptUrl: string;
  sourceVersion: number;
  projectionIds: string[];
} & IamInvitationListItem;

export type IamInvitationRevokeResult = IamTenantWriteResult & {
  invitationId: string;
  revoked: boolean;
};

export type IamInvitationAcceptResult = IamTenantWriteResult & {
  invitationId: string;
  grants: Array<IamGrant | IamResourceGrant>;
};

export type AcceptIamInvitationArgs = {
  token: string;
  idToken: string;
};

type CreateInvitationActionArgs =
  | {
      tenantId: string;
      email: string;
      target: { type: "tenant" };
      grants?: IamRoleGrantInput[];
      expiresAt?: string;
    }
  | {
      tenantId: string;
      email: string;
      target: {
        type: "resource";
        resourceType: string;
        resourceId: string;
        appliesTo?: IamBindingAppliesTo;
      };
      grant: IamResourceInvitationGrantInput;
      expiresAt?: string;
    };

type ListInvitationsFilterArgs =
  | {
      targetType?: never;
      resourceType?: never;
      resourceId?: never;
    }
  | {
      targetType: "tenant";
      resourceType?: never;
      resourceId?: never;
    }
  | {
      targetType: "resource";
      resourceType?: never;
      resourceId?: never;
    }
  | {
      targetType?: "resource";
      resourceType: string;
      resourceId: string;
    };

type ListInvitationsActionArgs<ActorValidators extends PropertyValidators> =
  ObjectType<ActorValidators> & {
    tenantId: string;
    cursor?: string;
    limit?: number;
    email?: string;
  } & ListInvitationsFilterArgs;

export function createInvitationActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;
  const listInvitationCommonArgs = {
    ...actorValidators,
    tenantId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    email: v.optional(v.string()),
  };
  const listInvitationsArgs = v.union(
    v.object(listInvitationCommonArgs),
    v.object({
      ...listInvitationCommonArgs,
      targetType: v.literal("tenant"),
    }),
    v.object({
      ...listInvitationCommonArgs,
      targetType: v.literal("resource"),
    }),
    v.object({
      ...listInvitationCommonArgs,
      targetType: v.optional(v.literal("resource")),
      resourceType: v.string(),
      resourceId: v.string(),
    }),
  ) as unknown as Validator<ListInvitationsActionArgs<ActorValidators>>;

  return {
    listInvitations: builder({
      args: listInvitationsArgs,
      handler: async (_ctx, args) => {
        return normalizeInvitationListResult(
          await call(
            "get",
            queryPath(tenantPath(args.tenantId, "invitations"), {
              cursor: args.cursor,
              limit: args.limit,
              email: args.email,
              target_type: args.targetType,
              resource_type: args.resourceType,
              resource_id: args.resourceId,
            }),
            headersFor(args),
          ),
        );
      },
    }),

    createInvitation: builder({
      args: v.union(
        v.object({
          tenantId: v.string(),
          email: v.string(),
          target: v.object({ type: v.literal("tenant") }),
          grants: v.optional(v.array(roleGrantValidator)),
          expiresAt: v.optional(v.string()),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          email: v.string(),
          target: v.object({
            type: v.literal("resource"),
            resourceType: v.string(),
            resourceId: v.string(),
            appliesTo: v.optional(appliesToValidator),
          }),
          grant: v.union(roleGrantValidator, resourceInvitationPermissionGrantValidator),
          expiresAt: v.optional(v.string()),
          ...actorValidators,
        }),
      ),
      handler: async (_ctx, args) => {
        const input = args as unknown as CreateInvitationActionArgs;
        const body =
          "grant" in input
            ? compactBody({
                email: input.email,
                target: compactBody({
                  type: "resource",
                  resource_type: input.target.resourceType,
                  resource_id: input.target.resourceId,
                  applies_to: input.target.appliesTo,
                }),
                grant: resourceInvitationGrantBody(input.grant),
                expires_at: input.expiresAt,
              })
            : compactBody({
                email: input.email,
                target: { type: "tenant" },
                grants: input.grants?.map(roleGrantBody),
                expires_at: input.expiresAt,
              });
        return normalizeInvitationCreateResult(
          await call("post", tenantPath(input.tenantId, "invitations"), headersFor(args), body),
        );
      },
    }),

    revokeInvitation: builder({
      args: {
        tenantId: v.string(),
        invitationId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "delete",
          tenantPath(args.tenantId, "invitations", args.invitationId),
          headersFor(args),
        );
        return {
          ...normalizeTenantWriteResult(result),
          invitationId: requiredString(result, "invitation_id", "invitationId"),
          revoked: result["revoked"] === true,
        } satisfies IamInvitationRevokeResult;
      },
    }),
  };
}

export async function acceptIamInvitation(
  ctx: CreateIamTenantContext,
  args: AcceptIamInvitationArgs,
  options: IamApiOptions = {},
): Promise<IamInvitationAcceptResult> {
  const identity = await ctx.auth.getUserIdentity();
  requireTokenIdentifier(identity?.tokenIdentifier);
  const call = makeIamApiCaller(options);
  const result = await call("post", "/v1/iam/invitations/accept", userActorHeaders(args.idToken), {
    token: args.token,
  });
  return {
    ...normalizeTenantWriteResult(result),
    invitationId: requiredString(result, "invitation_id", "invitationId"),
    grants: requiredRecordArray(result, "grants", "grants").map((grant, index) =>
      "applies_to" in grant
        ? normalizeResourceGrant(grant, `grants[${index}]`)
        : normalizeGrant(grant, `grants[${index}]`),
    ),
  };
}

function normalizeInvitationListResult(
  result: import("./shared.js").ApiRecord,
): IamInvitationListResult {
  const nextCursor = optionalString(result, "next_cursor", "nextCursor");
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    invitations: requiredRecordArray(result, "invitations", "invitations").map((invitation) => ({
      ...normalizeInvitationItem(invitation),
      createdAt: requiredString(invitation, "created_at", "invitations[].createdAt"),
      updatedAt: requiredString(invitation, "updated_at", "invitations[].updatedAt"),
    })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function normalizeInvitationCreateResult(
  result: import("./shared.js").ApiRecord,
): IamInvitationCreateResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    ...normalizeInvitationItem(result),
    token: requiredString(result, "token", "token"),
    acceptUrl: requiredString(result, "accept_url", "acceptUrl"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeInvitationItem(
  invitation: import("./shared.js").ApiRecord,
): IamInvitationListItem {
  const target = normalizeInvitationTarget(requiredRecord(invitation, "target", "target"));
  const base = {
    invitationId: requiredString(invitation, "invitation_id", "invitationId"),
    email: requiredString(invitation, "email", "email"),
    expiresAt: requiredString(invitation, "expires_at", "expiresAt"),
  };
  return target.type === "tenant"
    ? {
        ...base,
        target,
        grants: requiredRecordArray(invitation, "grants", "grants").map((grant, index) =>
          normalizeInvitationRoleGrant(grant, `grants[${index}]`),
        ),
      }
    : {
        ...base,
        target,
        grant: normalizeInvitationGrant(requiredRecord(invitation, "grant", "grant"), "grant"),
      };
}

function normalizeInvitationGrant(
  grant: import("./shared.js").ApiRecord,
  resultName: string,
): IamInvitationGrant {
  const type = requiredString(grant, "type", `${resultName}.type`);
  const expiresAt = grant["expires_at"];
  if (expiresAt !== null && typeof expiresAt !== "string") {
    throw new Error(`IAM API response has invalid ${resultName}.expiresAt.`);
  }
  if (type === "role") {
    return {
      conferralId: requiredString(grant, "conferral_id", `${resultName}.conferralId`),
      type,
      roleId: requiredString(grant, "role_id", `${resultName}.roleId`),
      expiresAt,
    };
  }
  if (type === "permission") {
    const effect = requiredEffect(grant, "effect", `${resultName}.effect`);
    if (effect !== "allow") {
      throw new Error(`IAM API response has invalid ${resultName}.effect.`);
    }
    return {
      conferralId: requiredString(grant, "conferral_id", `${resultName}.conferralId`),
      type,
      permissionId: requiredString(grant, "permission_id", `${resultName}.permissionId`),
      permissionKey: requiredString(grant, "permission_key", `${resultName}.permissionKey`),
      effect,
      expiresAt,
    };
  }
  throw new Error(`IAM API response has invalid ${resultName}.type.`);
}

function normalizeInvitationRoleGrant(
  grant: import("./shared.js").ApiRecord,
  resultName: string,
): IamInvitationRoleGrant {
  const normalized = normalizeInvitationGrant(grant, resultName);
  if (normalized.type !== "role") {
    throw new Error(`IAM API response has invalid ${resultName}.type.`);
  }
  return normalized;
}

function resourceInvitationGrantBody(grant: IamResourceInvitationGrantInput) {
  return "role" in grant
    ? roleGrantBody(grant)
    : compactBody({
        permission_key: grant.permissionKey,
        expires_at: grant.expiresAt,
      });
}

function normalizeInvitationTarget(target: import("./shared.js").ApiRecord): IamInvitationTarget {
  const type = requiredString(target, "type", "target.type");
  if (type === "tenant") return { type };
  if (type !== "resource") {
    throw new Error("IAM API response has invalid target.type.");
  }
  return {
    type,
    resourceType: requiredString(target, "resource_type", "target.resourceType"),
    resourceId: requiredString(target, "resource_id", "target.resourceId"),
    appliesTo: requiredAppliesTo(target, "applies_to", "target.appliesTo"),
  };
}
