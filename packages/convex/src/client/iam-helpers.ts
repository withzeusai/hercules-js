import { Hercules } from "@usehercules/sdk";
import type {
  GrantCreateParams,
  GrantCreateResponse,
} from "@usehercules/sdk/resources/iam/tenants/resources/grants";
import type {
  ActionBuilder,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { IamTenantAccessStatusResult } from "./index.js";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_API_KEY_ENV_VAR = "HERCULES_API_KEY";
const TENANT_PAGE_LIMIT = 100;

export type IamBindingAppliesTo = "self" | "self_and_descendants";
export type IamRoleReference = { id: string; key?: never } | { key: string; id?: never };

export type IamResourceRoleGrant = {
  grantId: string;
  type: "resource_role";
  roleId: string;
  expiresAt: string | null;
  appliesTo: IamBindingAppliesTo;
};

export type IamResourceGrantWriteResult = {
  tenantId: string;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
  grant: IamResourceRoleGrant;
};

export type ResourceCreatorBootstrapTarget = {
  tenantId: string;
  resourceId: string;
  creatorHerculesAuthUserId: string;
  state: "provisioning" | "active";
};

export type ResourceCreatorBootstrapActivationArgs = {
  resourceId: string;
  creatorHerculesAuthUserId: string;
  grant: IamResourceGrantWriteResult;
};

export type ResourceCreatorBootstrapResult =
  | {
      resourceId: string;
      state: "active";
      bootstrapped: false;
    }
  | {
      resourceId: string;
      state: "active";
      bootstrapped: true;
      grant: IamResourceGrantWriteResult;
    };

export type ResourceCreatorBootstrapTenantPage = {
  tenants: Array<{ tenantId: string; status: string }>;
  cursor?: string;
};

type BootstrapTargetReference = FunctionReference<
  "query",
  "internal",
  { resourceId: string },
  ResourceCreatorBootstrapTarget | null
>;

type ListMyTenantsReference = FunctionReference<
  "query",
  "public",
  { tokenIdentifier?: string; cursor?: string; limit?: number },
  ResourceCreatorBootstrapTenantPage
>;

type GetTenantAccessStatusReference = FunctionReference<
  "query",
  "public",
  { tokenIdentifier?: string },
  IamTenantAccessStatusResult
>;

type ActivateResourceReference = FunctionReference<
  "mutation",
  "internal",
  ResourceCreatorBootstrapActivationArgs,
  void
>;

export type ResourceCreatorBootstrapClient = {
  iam: {
    tenants: {
      resources: {
        grants: {
          create: Hercules["iam"]["tenants"]["resources"]["grants"]["create"];
        };
      };
    };
  };
};

export type CreateResourceCreatorBootstrapActionOptions<DataModel extends GenericDataModel> = {
  authenticatedAction: ActionBuilder<DataModel, "public">;
  resourceType: string;
  managerRole: IamRoleReference;
  appliesTo: IamBindingAppliesTo;
  getTenantAccessStatus: GetTenantAccessStatusReference;
  listMyTenants: ListMyTenantsReference;
  getBootstrapTarget: BootstrapTargetReference;
  activateResource: ActivateResourceReference;
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: ResourceCreatorBootstrapClient;
};

export function createResourceCreatorBootstrapAction<DataModel extends GenericDataModel>(
  options: CreateResourceCreatorBootstrapActionOptions<DataModel>,
) {
  let client = options.client;

  return options.authenticatedAction({
    args: { resourceId: v.string() },
    handler: async (ctx, args): Promise<ResourceCreatorBootstrapResult> => {
      const { tokenIdentifier, userId } = await getAuthenticatedUser(ctx);
      const target = await ctx.runQuery(options.getBootstrapTarget, {
        resourceId: args.resourceId,
      });

      if (!isValidTargetForCaller(target, args.resourceId, userId)) {
        throwIamDenied();
      }

      const hasActiveDefaultTenant = await callerHasActiveDefaultTenant(
        ctx,
        options.getTenantAccessStatus,
        tokenIdentifier,
      );
      if (!hasActiveDefaultTenant) {
        throwIamDenied();
      }

      const hasActiveTargetTenant = await callerHasActiveTargetTenant(ctx, options.listMyTenants, {
        tenantId: target.tenantId,
        tokenIdentifier,
      });
      if (!hasActiveTargetTenant) {
        throwIamDenied();
      }

      if (target.state === "active") {
        return {
          resourceId: target.resourceId,
          state: "active",
          bootstrapped: false,
        };
      }

      client ??= createClient(options);
      const grantBody = {
        tenant_id: target.tenantId,
        resource_type: options.resourceType,
        user_token_identifier: null,
        subject: { type: "user", user_id: userId },
        role: options.managerRole,
        applies_to: options.appliesTo,
      } satisfies GrantCreateParams;
      const grant = normalizeResourceGrantWriteResult(
        await client.iam.tenants.resources.grants.create(target.resourceId, grantBody),
      );

      await ctx.runMutation(options.activateResource, {
        resourceId: target.resourceId,
        creatorHerculesAuthUserId: userId,
        grant,
      });

      return {
        resourceId: target.resourceId,
        state: "active",
        bootstrapped: true,
        grant,
      };
    },
  });
}

async function getAuthenticatedUser<DataModel extends GenericDataModel>(
  ctx: Pick<GenericActionCtx<DataModel>, "auth">,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier || !identity.subject) {
    throwUnauthenticated();
  }

  const tokenSubject = parseTokenIdentifierSubject(identity.tokenIdentifier);
  if (tokenSubject !== identity.subject) {
    throwUnauthenticated();
  }

  return {
    tokenIdentifier: identity.tokenIdentifier,
    userId: identity.subject,
  };
}

function parseTokenIdentifierSubject(tokenIdentifier: string) {
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    throwUnauthenticated();
  }
  return tokenIdentifier.slice(separatorIndex + 1);
}

function isValidTargetForCaller(
  target: ResourceCreatorBootstrapTarget | null,
  resourceId: string,
  userId: string,
): target is ResourceCreatorBootstrapTarget {
  return (
    target !== null &&
    target.resourceId === resourceId &&
    target.creatorHerculesAuthUserId === userId &&
    target.tenantId.length > 0 &&
    (target.state === "provisioning" || target.state === "active")
  );
}

async function callerHasActiveDefaultTenant<DataModel extends GenericDataModel>(
  ctx: Pick<GenericActionCtx<DataModel>, "runQuery">,
  getTenantAccessStatus: GetTenantAccessStatusReference,
  tokenIdentifier: string,
) {
  const accessStatus = await ctx.runQuery(getTenantAccessStatus, {
    tokenIdentifier,
  });
  return accessStatus.kind === "principal" && accessStatus.status === "active";
}

async function callerHasActiveTargetTenant<DataModel extends GenericDataModel>(
  ctx: Pick<GenericActionCtx<DataModel>, "runQuery">,
  listMyTenants: ListMyTenantsReference,
  args: { tenantId: string; tokenIdentifier: string },
) {
  let cursor: string | undefined;
  do {
    const page = await ctx.runQuery(listMyTenants, {
      tokenIdentifier: args.tokenIdentifier,
      cursor,
      limit: TENANT_PAGE_LIMIT,
    });
    if (
      page.tenants.some((tenant) => tenant.tenantId === args.tenantId && tenant.status === "active")
    ) {
      return true;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  return false;
}

function createClient(options: {
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
}): ResourceCreatorBootstrapClient {
  const envVarName = options.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV_VAR;
  const apiKey = options.apiKey ?? process.env[envVarName];
  if (!apiKey) {
    throw new Error(`${envVarName} is required for Hercules IAM API calls.`);
  }
  return new Hercules({
    apiKey,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  });
}

function normalizeResourceGrantWriteResult(
  result: GrantCreateResponse,
): IamResourceGrantWriteResult {
  if (result.grant.type !== "resource_role" || result.grant.applies_to === undefined) {
    throw new Error("Hercules IAM response has invalid resource grant type.");
  }

  return {
    tenantId: result.tenant_id,
    changed: result.changed,
    sourceVersion: result.source_version,
    projectionIds: result.projection_ids,
    grant: {
      grantId: result.grant.grant_id,
      type: result.grant.type,
      roleId: result.grant.role_id,
      expiresAt: result.grant.expires_at,
      appliesTo: result.grant.applies_to,
    },
  };
}

function throwUnauthenticated(): never {
  throw new ConvexError({
    code: "UNAUTHENTICATED",
    message: "Authentication required",
  });
}

function throwIamDenied(): never {
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "Access denied",
  });
}
