import type { ActionBuilder, GenericActionCtx, GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  appliesToValidator,
  compactBody,
  type IamActionModuleContext,
  type IamApiOptions,
  type IamBindingAppliesTo,
  type IamResourcePermissionOverride,
  type IamResourcePermissionGrant,
  type IamResourcePermissionSubject,
  type IamResourceGrant,
  type IamResourceRoleGrant,
  type IamResourceSubject,
  type IamRoleReference,
  type IamTenantWriteResult,
  makeIamApiCaller,
  normalizeResourceGrant,
  normalizeTenantWriteResult,
  parseTokenIdentifierSubject,
  requiredRecord,
  requiredRecordArray,
  requiredString,
  resourceGrantPath,
  resourcePermissionSubjectBody,
  resourcePermissionSubjectValidator,
  resourcePermissionOverrideBody,
  resourcePermissionOverrideValidator,
  resourceSubjectBody,
  resourceSubjectValidator,
  roleReferenceBody,
  roleReferenceValidator,
  serviceActorHeaders,
  tenantPath,
  throwIamDenied,
} from "./shared.js";

const resourceGrantValidator = v.object({
  role: roleReferenceValidator,
  appliesTo: v.optional(appliesToValidator),
  expiresAt: v.optional(v.union(v.string(), v.null())),
});

const resourceGrantSubjectValidator = v.object({
  subject: resourceSubjectValidator,
  grants: v.array(resourceGrantValidator),
});

type ResourceGrantSubjectInput = {
  subject: IamResourceSubject;
  grants: Array<{
    role: IamRoleReference;
    appliesTo?: IamBindingAppliesTo;
    expiresAt?: string | null;
  }>;
};

type ResourcePermissionOverridesInput = {
  tenantId: string;
  subject: IamResourcePermissionSubject;
  resourceType: string;
  target: { type: "all" } | { type: "resource"; resourceId: string };
  appliesTo?: IamBindingAppliesTo;
  overrides: IamResourcePermissionOverride[];
};

export type IamResourceGrantWriteResult = IamTenantWriteResult & {
  grant: IamResourceGrant;
};

export type IamResourceGrantsReplaceResult = IamTenantWriteResult & {
  resourceType: string;
  resourceId: string;
  subjects: Array<{
    subject: IamResourceSubject;
    grants: IamResourceRoleGrant[];
  }>;
};

export type IamResourcePermissionOverridesResult = IamTenantWriteResult & {
  grants: IamResourcePermissionGrant[];
};

export type ResourceCreatorBootstrapTarget = {
  tenantId: string;
  resourceId: string;
  creatorHerculesAuthUserId: string;
  state: "provisioning" | "active";
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

export type CreateResourceCreatorBootstrapActionOptions<DataModel extends GenericDataModel> =
  IamApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    resourceType: string;
    managerRole: IamRoleReference;
    appliesTo: IamBindingAppliesTo;
    getBootstrapTarget: (
      ctx: GenericActionCtx<DataModel>,
      args: { resourceId: string },
    ) => Promise<ResourceCreatorBootstrapTarget | null>;
    listMyTenants: (
      ctx: GenericActionCtx<DataModel>,
    ) => Promise<Array<{ tenantId: string; status: string }>>;
    activateResource: (
      ctx: GenericActionCtx<DataModel>,
      args: {
        resourceId: string;
        creatorHerculesAuthUserId: string;
        grant: IamResourceGrantWriteResult;
      },
    ) => Promise<void>;
  };

export function createResourceActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    createResourceGrant: builder({
      args: {
        tenantId: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        subject: resourceSubjectValidator,
        role: roleReferenceValidator,
        appliesTo: v.optional(appliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeResourceGrantWriteResult(
          await call(
            "post",
            resourceGrantPath(args.tenantId, args.resourceType, args.resourceId),
            headersFor(args),
            compactBody({
              subject: resourceSubjectBody(args.subject),
              role: roleReferenceBody(args.role),
              applies_to: args.appliesTo,
              expires_at: args.expiresAt,
            }),
          ),
        ),
    }),

    replaceResourceGrants: builder({
      args: {
        tenantId: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        subjects: v.array(resourceGrantSubjectValidator),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const subjects = args.subjects as unknown as ResourceGrantSubjectInput[];
        return normalizeResourceGrantsReplaceResult(
          await call(
            "put",
            resourceGrantPath(args.tenantId, args.resourceType, args.resourceId),
            headersFor(args),
            {
              subjects: subjects.map((subject) => ({
                subject: resourceSubjectBody(subject.subject),
                grants: subject.grants.map((grant) =>
                  compactBody({
                    role: roleReferenceBody(grant.role),
                    applies_to: grant.appliesTo,
                    expires_at: grant.expiresAt,
                  }),
                ),
              })),
            },
          ),
        );
      },
    }),

    replaceResourcePermissionOverrides: builder({
      args: v.union(
        v.object({
          tenantId: v.string(),
          subject: resourcePermissionSubjectValidator,
          resourceType: v.string(),
          target: v.object({ type: v.literal("all") }),
          appliesTo: v.optional(v.literal("self")),
          overrides: v.array(resourcePermissionOverrideValidator),
          ...actorValidators,
        }),
        v.object({
          tenantId: v.string(),
          subject: resourcePermissionSubjectValidator,
          resourceType: v.string(),
          target: v.object({ type: v.literal("resource"), resourceId: v.string() }),
          appliesTo: v.optional(appliesToValidator),
          overrides: v.array(resourcePermissionOverrideValidator),
          ...actorValidators,
        }),
      ),
      handler: async (_ctx, args) => {
        const input = args as unknown as ResourcePermissionOverridesInput;
        const result = await call(
          "put",
          tenantPath(input.tenantId, "resource-permission-overrides"),
          headersFor(args),
          {
            subject: resourcePermissionSubjectBody(input.subject),
            resource_type: input.resourceType,
            target:
              input.target.type === "all"
                ? { type: "all" }
                : {
                    type: "resource",
                    resource_id: input.target.resourceId,
                  },
            applies_to: input.appliesTo ?? "self",
            overrides: input.overrides.map(resourcePermissionOverrideBody),
          },
        );
        return {
          ...normalizeTenantWriteResult(result),
          grants: requiredRecordArray(result, "grants", "grants").map((record) => {
            const grant = normalizeResourceGrant(record);
            if (grant.type !== "permission") {
              throw new Error("IAM API response has invalid resource permission grant.");
            }
            return grant;
          }),
        } satisfies IamResourcePermissionOverridesResult;
      },
    }),
  };
}

export function createResourceCreatorBootstrapAction<DataModel extends GenericDataModel>(
  options: CreateResourceCreatorBootstrapActionOptions<DataModel>,
) {
  const call = makeIamApiCaller(options);

  return options.authenticatedAction({
    args: { resourceId: v.string() },
    handler: async (ctx, args): Promise<ResourceCreatorBootstrapResult> => {
      const identity = await ctx.auth.getUserIdentity();
      const actorUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
      const target = await options.getBootstrapTarget(ctx, args);
      if (
        !target ||
        target.resourceId !== args.resourceId ||
        target.creatorHerculesAuthUserId !== actorUserId
      ) {
        throwIamDenied();
      }

      const tenants = await options.listMyTenants(ctx);
      if (
        !tenants.some((tenant) => tenant.tenantId === target.tenantId && tenant.status === "active")
      ) {
        throwIamDenied();
      }

      if (target.state === "active") {
        return {
          resourceId: target.resourceId,
          state: "active",
          bootstrapped: false,
        };
      }

      const grant = normalizeResourceGrantWriteResult(
        await call(
          "post",
          resourceGrantPath(target.tenantId, options.resourceType, target.resourceId),
          serviceActorHeaders(),
          {
            subject: {
              type: "user",
              user_id: actorUserId,
            },
            role: roleReferenceBody(options.managerRole),
            applies_to: options.appliesTo,
          },
        ),
      );
      await options.activateResource(ctx, {
        resourceId: target.resourceId,
        creatorHerculesAuthUserId: actorUserId,
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

function normalizeResourceGrantsReplaceResult(
  result: import("./shared.js").ApiRecord,
): IamResourceGrantsReplaceResult {
  return {
    ...normalizeTenantWriteResult(result),
    resourceType: requiredString(result, "resource_type", "resourceType"),
    resourceId: requiredString(result, "resource_id", "resourceId"),
    subjects: requiredRecordArray(result, "subjects", "subjects").map((subject) => ({
      subject: normalizeResourceSubject(requiredRecord(subject, "subject", "subjects[].subject")),
      grants: requiredRecordArray(subject, "grants", "subjects[].grants").map(
        normalizeResourceRoleGrant,
      ),
    })),
  };
}

function normalizeResourceGrantWriteResult(
  result: import("./shared.js").ApiRecord,
): IamResourceGrantWriteResult {
  return {
    ...normalizeTenantWriteResult(result),
    grant: normalizeResourceGrant(requiredRecord(result, "grant", "grant")),
  };
}

function normalizeResourceRoleGrant(result: import("./shared.js").ApiRecord): IamResourceRoleGrant {
  const grant = normalizeResourceGrant(result);
  if (grant.type !== "role") {
    throw new Error("IAM API response has invalid resource role grant.");
  }
  return grant;
}

function normalizeResourceSubject(subject: import("./shared.js").ApiRecord): IamResourceSubject {
  const type = requiredString(subject, "type", "subject.type");
  if (type === "user") {
    return {
      type,
      userId: requiredString(subject, "user_id", "subject.userId"),
    };
  }
  if (type === "group") {
    return {
      type,
      groupId: requiredString(subject, "group_id", "subject.groupId"),
    };
  }
  throw new Error("IAM API response has invalid subject.type.");
}
