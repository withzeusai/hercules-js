import { Hercules } from "@usehercules/sdk";
import type { ActionBuilder, GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { IamDeploymentEntryMirrorResult, Membership, ScopeRoleSummary } from "./index";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_IAM_API_KEY_ENV_VAR = "HERCULES_API_KEY";

type WriteResult = Record<string, unknown>;
export type IamBindingAppliesTo = "self" | "self_and_descendants";

export type IamResourceGrantWriteResult = {
  accessScopeId: string;
  grantId: string;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamResourceGrantsReplaceResult = {
  accessScopeId: string;
  resourceType: string;
  resourceId: string;
  subjects: Array<{
    principalId: string;
    grants: Array<{
      grantId: string;
      roleId: string | null;
      permissionId: string | null;
      appliesTo: IamBindingAppliesTo;
      expiresAt: string | null;
    }>;
  }>;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamMemberRolesReplaceResult = {
  accessScopeId: string;
  principalId: string;
  roleIds: string[];
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamGrantableRoleTarget =
  | { type: "scope" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      appliesTo?: IamBindingAppliesTo;
    };

export type IamGrantableRoleListResult = {
  accessScopeId: string;
  roles: ScopeRoleSummary[];
};

export type IamScopeCreateResult = {
  accessScopeId: string;
  created?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamInvitationCreateResult = {
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

export type IamInvitationAcceptResult = {
  accessScopeId: string;
  invitationId: string;
  principalId: string;
  roleIds: string[];
  changed?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamDeploymentEntryResult = {
  allowed: boolean;
  reason: string;
  principalId?: string;
  status?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  stateVersion: number;
  changed: boolean;
};

export type IamGroupListResult = {
  accessScopeId: string;
  groups: Array<{
    groupPrincipalId: string;
    name: string | null;
    memberCount: number;
    archived: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type IamGroupWriteResult = {
  accessScopeId: string;
  groupPrincipalId: string;
  changed?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamGroupMemberWriteResult = IamGroupWriteResult & {
  memberPrincipalId: string;
  membershipId?: string;
};

export type IamResourceInvitationListResult = {
  accessScopeId: string;
  invitations: Array<{
    invitationId: string;
    email: string;
    resourceType: string;
    resourceId: string;
    conferralType: "role" | "permission" | null;
    roleId: string | null;
    permissionId: string | null;
    appliesTo: IamBindingAppliesTo;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type IamRoleOverridesResult = {
  accessScopeId: string;
  roleId: string;
  overrides: Array<{
    permissionId: string;
    permissionKey: string;
    effect: "allow" | "deny";
  }>;
};

export type IamUserExceptionsResult = {
  accessScopeId: string;
  principalId: string;
  exceptions: Array<{
    permissionId: string;
    permissionKey: string;
    effect: "allow" | "deny";
    expiresAt: string | null;
  }>;
};

export type IamSdkClient = {
  post<T>(path: string, options: { body: Record<string, unknown> }): Promise<T>;
};

export type IamApiOptions = {
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: IamSdkClient;
};

export type CreateIamServiceActionsOptions<DataModel extends GenericDataModel> = IamApiOptions & {
  internalAction: ActionBuilder<DataModel, "internal">;
};

export type CreateIamManagementActionsOptions<DataModel extends GenericDataModel> =
  IamApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
  };

export type CreateDeploymentEntryActionOptions<DataModel extends GenericDataModel> =
  IamApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    getDeploymentEntryStatus?: (
      ctx: GenericActionCtx<DataModel>,
    ) => Promise<IamDeploymentEntryMirrorResult>;
  };

// The full admission-policy surface the entry evaluator handles.
export type IamAccountEntryMode = "open" | "allowlisted_only" | "invite_only" | "approval_required";

export type CreateIamScopeArgs = {
  name: string;
  defaultRoleKey?: string;
  accountEntryMode?: IamAccountEntryMode;
};

export type CreateIamInvitationArgs = {
  scopeId: string;
  email: string;
  roleIds?: string[];
  roleKeys?: string[];
  expiresInDays?: number;
};

export type CreateResourceInvitationArgs = {
  scopeId: string;
  email: string;
  resourceType: string;
  resourceId: string;
  /** Conferred grant — exactly one of these. A custom role or a single permission. */
  roleKey?: string;
  permissionKey?: string;
  appliesTo?: IamBindingAppliesTo;
  expiresInDays?: number;
};

export type AcceptIamInvitationArgs = {
  token: string;
  /**
   * The signed-in user's OIDC ID token (`user.id_token`): a JWT with three
   * dot-separated segments. Never pass a user or subject id (for example
   * `user.profile.sub`); the control plane verifies the token signature, so a
   * bare id is rejected.
   */
  idToken: string;
};

const serviceActor = { actor_mode: "service" as const };

export type CreateIamScopeContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null>;
  };
};

export type CreateIamScopeActionOptions<DataModel extends GenericDataModel> = IamApiOptions & {
  authenticatedAction: ActionBuilder<DataModel, "public">;
  canCreateScope: (
    ctx: CreateIamScopeContext,
    args: CreateIamScopeArgs,
  ) => boolean | Promise<boolean>;
};

export type ResourceCreatorBootstrapTarget = {
  scopeId: string;
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
    managerRoleKey: string;
    appliesTo: IamBindingAppliesTo;
    getBootstrapTarget: (
      ctx: GenericActionCtx<DataModel>,
      args: { resourceId: string },
    ) => Promise<ResourceCreatorBootstrapTarget | null>;
    listMyMemberships: (ctx: GenericActionCtx<DataModel>) => Promise<Membership[]>;
    activateResource: (
      ctx: GenericActionCtx<DataModel>,
      args: {
        resourceId: string;
        creatorHerculesAuthUserId: string;
        grant: IamResourceGrantWriteResult;
      },
    ) => Promise<void>;
  };

export type IamRecipient =
  | { type: "user"; herculesAuthUserId: string }
  | { type: "principal"; principalId: string };

const iamRecipientValidator = v.union(
  v.object({
    type: v.literal("user"),
    herculesAuthUserId: v.string(),
  }),
  v.object({
    type: v.literal("principal"),
    principalId: v.string(),
  }),
);

const optionalRoleRef = {
  roleId: v.optional(v.string()),
  roleKey: v.optional(v.string()),
};

const accountEntryModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);
const bindingAppliesToValidator = v.union(v.literal("self"), v.literal("self_and_descendants"));
const grantableRoleTargetValidator = v.union(
  v.object({ type: v.literal("scope") }),
  v.object({
    type: v.literal("resource"),
    resourceType: v.string(),
    resourceId: v.string(),
    appliesTo: v.optional(bindingAppliesToValidator),
  }),
);
const MAX_MEMBER_ROLE_REPLACEMENT_ENTRIES = 500;
const MIN_RESOURCE_GRANT_REPLACEMENT_SUBJECTS = 1;
const MAX_RESOURCE_GRANT_REPLACEMENT_SUBJECTS = 100;
const MAX_RESOURCE_GRANT_REPLACEMENT_ENTRIES = 500;
const resourceGrantReplacementValidator = v.object({
  roleKey: v.optional(v.string()),
  permissionKey: v.optional(v.string()),
  appliesTo: v.optional(bindingAppliesToValidator),
  expiresAt: v.optional(v.union(v.string(), v.null())),
});
const resourceGrantSubjectReplacementValidator = v.object({
  recipient: iamRecipientValidator,
  grants: v.array(resourceGrantReplacementValidator),
});
const resourceRuleSubjectValidator = v.union(
  v.object({ type: v.literal("principal"), principalId: v.string() }),
  v.object({ type: v.literal("role"), roleKey: v.string() }),
);
const resourceRuleTargetValidator = v.union(
  v.object({ mode: v.literal("all") }),
  v.object({ mode: v.literal("specific"), resourceId: v.string() }),
);
const resourceRuleEffectValidator = v.union(v.literal("allow"), v.literal("deny"));
const resourceRuleReplacementEffectValidator = v.union(
  v.literal("allow"),
  v.literal("deny"),
  v.literal("clear"),
);

/**
 * Builds the managed IAM write actions (assign/remove roles,
 * invite, create org custom roles, resource grants, overrides, expiries,
 * member lifecycle, admission rules, entry mode, and groups) plus the raw
 * reads backing them (group/resource-invitation lists, role overrides, user
 * exceptions). Each one calls the Hercules control plane, so it needs the
 * `HERCULES_API_KEY` secret. Wire it in an internal `convex/iamService.ts`
 * module only when the app needs trusted service automation, and re-export
 * only the actions that workflow uses.
 *
 * These are internal service-authority actions. Do not re-export them as public
 * Convex actions. Use {@link createIamManagementActions} for public resource
 * management by signed-in app users.
 */
export function createIamServiceActions<DataModel extends GenericDataModel>(
  options: CreateIamServiceActionsOptions<DataModel>,
) {
  const callIamApi = makeIamApiCaller(options);
  const { internalAction } = options;

  return {
    archiveScope: internalAction({
      args: { scopeId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId };
        return await callIamApi("/v1/iam/scopes/archive", body);
      },
    }),

    setDefaultRole: internalAction({
      args: { scopeId: v.string(), ...optionalRoleRef },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/scopes/set-default-role", body);
      },
    }),

    createInvitation: internalAction({
      args: {
        scopeId: v.string(),
        email: v.string(),
        roleIds: v.optional(v.array(v.string())),
        roleKeys: v.optional(v.array(v.string())),
        expiresInDays: v.optional(v.number()),
      },
      handler: async (_ctx, args) => {
        const result = await createIamInvitation(args, options);
        return result;
      },
    }),

    revokeInvitation: internalAction({
      args: { scopeId: v.string(), invitationId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          invitation_id: args.invitationId,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/invitations/revoke", body);
      },
    }),

    assignRole: internalAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/roles/assign", body);
      },
    }),

    removeRole: internalAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/roles/remove", body);
      },
    }),

    createOrgCustomRole: internalAction({
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
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/roles/create-org-custom", body);
      },
    }),

    updateRolePermissions: internalAction({
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
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/roles/update-permissions", body);
      },
    }),

    setUserExceptions: internalAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        allow: v.array(v.string()),
        deny: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          allow: args.allow,
          deny: args.deny,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/user-exceptions/set", body);
      },
    }),

    createResourceGrant: internalAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        resourceType: v.string(),
        resourceId: v.string(),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        requireExactResource(args);
        requireExactResourceForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/resource-grants/create", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    replaceResourceGrants: internalAction({
      args: {
        scopeId: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        subjects: v.array(resourceGrantSubjectReplacementValidator),
      },
      handler: async (_ctx, args) => {
        requireExactResource(args);
        const body = {
          scope_id: args.scopeId,
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          subjects: resourceGrantReplacementSubjectsBody(args.subjects),
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/resource-grants/replace", body);
        return normalizeIamResourceGrantsReplaceResult(result);
      },
    }),

    replaceMemberRoles: internalAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        roleKeys: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          role_keys: memberRoleReplacementKeysBody(args.roleKeys),
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/roles/replace", body);
        return normalizeIamMemberRolesReplaceResult(result);
      },
    }),

    createResourceInvitation: internalAction({
      args: {
        scopeId: v.string(),
        email: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresInDays: v.optional(v.number()),
      },
      handler: async (_ctx, args) => {
        return await createResourceInvitation(args, options);
      },
    }),

    setResourcePermissionRule: internalAction({
      args: {
        scopeId: v.string(),
        subject: resourceRuleSubjectValidator,
        resourceType: v.string(),
        target: resourceRuleTargetValidator,
        permissionKey: v.string(),
        effect: resourceRuleEffectValidator,
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          subject: resourceRuleSubjectBody(args.subject),
          resource_type: args.resourceType,
          target: resourceRuleTargetBody(args.target),
          permission_key: args.permissionKey,
          effect: args.effect,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/resource-rules/set", body);
      },
    }),

    setResourcePermissionRules: internalAction({
      args: {
        scopeId: v.string(),
        subject: resourceRuleSubjectValidator,
        resourceType: v.string(),
        target: resourceRuleTargetValidator,
        appliesTo: v.optional(bindingAppliesToValidator),
        rules: v.array(
          v.object({
            permissionKey: v.string(),
            effect: resourceRuleReplacementEffectValidator,
            expiresAt: v.optional(v.union(v.string(), v.null())),
          }),
        ),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          subject: resourceRuleSubjectBody(args.subject),
          resource_type: args.resourceType,
          target: resourceRuleTargetBody(args.target),
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          rules: args.rules.map((rule) => ({
            permission_key: rule.permissionKey,
            effect: rule.effect,
            expires_at: rule.expiresAt,
          })),
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/resource-rules/replace", body);
      },
    }),

    revokeResourceGrant: internalAction({
      args: { scopeId: v.string(), grantId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          grant_id: args.grantId,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/resource-grants/revoke", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    setGrantExpiry: internalAction({
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
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/expiries/set", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    setRoleOverride: internalAction({
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
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/role-overrides/set", body);
      },
    }),

    // Adds a member to an organization scope, identified by their Hercules
    // Auth user id, with an optional role (the scope default role when
    // omitted). It also restores a previously removed or suspended member to
    // active.
    addMember: internalAction({
      args: {
        scopeId: v.string(),
        herculesAuthUserId: v.string(),
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          hercules_auth_user_id: args.herculesAuthUserId,
          ...roleRef(args),
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/members/add", body);
      },
    }),

    setMemberStatus: internalAction({
      args: {
        scopeId: v.string(),
        principalId: v.string(),
        status: v.union(v.literal("active"), v.literal("suspended")),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          status: args.status,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/members/status", body);
      },
    }),

    removeMember: internalAction({
      args: { scopeId: v.string(), principalId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/members/remove", body);
      },
    }),

    approveMember: internalAction({
      args: { scopeId: v.string(), principalId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/members/approve", body);
      },
    }),

    upsertAdmissionRule: internalAction({
      args: {
        scopeId: v.string(),
        effect: v.union(v.literal("allow"), v.literal("deny")),
        subjectType: v.union(v.literal("email"), v.literal("domain")),
        subjectValue: v.string(),
        reason: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          effect: args.effect,
          subject_type: args.subjectType,
          subject_value: args.subjectValue,
          reason: args.reason,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/admission-rules/upsert", body);
      },
    }),

    archiveAdmissionRule: internalAction({
      args: { scopeId: v.string(), ruleId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          rule_id: args.ruleId,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/admission-rules/archive", body);
      },
    }),

    setAccountEntryMode: internalAction({
      args: {
        scopeId: v.string(),
        accountEntryMode: accountEntryModeValidator,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          account_entry_mode: args.accountEntryMode,
          ...serviceActor,
        };
        return await callIamApi("/v1/iam/entry-mode/set", body);
      },
    }),

    createGroup: internalAction({
      args: { scopeId: v.string(), name: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          name: args.name,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/create", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    renameGroup: internalAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        name: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          name: args.name,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/rename", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    // Archive is the group's terminal state and only removal path (no hard delete).
    archiveGroup: internalAction({
      args: { scopeId: v.string(), groupPrincipalId: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/archive", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    listGroups: internalAction({
      args: { scopeId: v.string(), includeArchived: v.optional(v.boolean()) },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          include_archived: args.includeArchived,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/list", body);
        return normalizeIamGroupListResult(result);
      },
    }),

    addGroupMember: internalAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        memberPrincipalId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          member_principal_id: args.memberPrincipalId,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/members/add", body);
        return normalizeIamGroupMemberWriteResult(result);
      },
    }),

    removeGroupMember: internalAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        memberPrincipalId: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          member_principal_id: args.memberPrincipalId,
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/groups/members/remove", body);
        return normalizeIamGroupMemberWriteResult(result);
      },
    }),

    listResourceInvitations: internalAction({
      args: { scopeId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...serviceActor };
        const result = await callIamApi("/v1/iam/invitations/list-resource", body);
        return normalizeIamResourceInvitationListResult(result);
      },
    }),

    getRoleOverrides: internalAction({
      args: { scopeId: v.string(), ...optionalRoleRef },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/role-overrides/get", body);
        return normalizeIamRoleOverridesResult(result);
      },
    }),

    getUserExceptions: internalAction({
      args: { scopeId: v.string(), recipient: iamRecipientValidator },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...serviceActor,
        };
        const result = await callIamApi("/v1/iam/user-exceptions/get", body);
        return normalizeIamUserExceptionsResult(result);
      },
    }),
  };
}

/**
 * Builds the deployment-admission action used by the managed auth callback.
 * Keep this in the baseline IAM module so apps do not instantiate the full
 * iam-management action collection only to enter a deployment.
 */
export function createDeploymentEntryAction<DataModel extends GenericDataModel>(
  options: CreateDeploymentEntryActionOptions<DataModel>,
) {
  const callIamApi = makeIamApiCaller(options);

  return options.authenticatedAction({
    args: { idToken: v.string() },
    handler: async (ctx, args) => {
      const idToken = normalizeIdToken(args.idToken);
      if (options.getDeploymentEntryStatus) {
        const mirror = await options.getDeploymentEntryStatus(ctx);
        if (mirror.kind === "principal" && mirror.status === "active") {
          return activeDeploymentEntryResultFromMirror(mirror);
        }
      }

      const result = await callIamApi("/v1/iam/entry", {
        id_token: idToken,
      });
      return normalizeIamDeploymentEntryResult(result);
    },
  });
}

/**
 * Builds authenticated public actions for end-user IAM management. The
 * control plane verifies the supplied ID token and applies the operation's
 * scope, Owner, or resource-level RBAC gate.
 *
 * Every action's `idToken` argument must be the signed-in user's OIDC ID token
 * (`user.id_token`): a JWT with three dot-separated segments. Never pass a user
 * or subject id (for example `user.profile.sub`); the SDK rejects values that
 * are not JWT-shaped before calling the API.
 */
export function createIamManagementActions<DataModel extends GenericDataModel>(
  options: CreateIamManagementActionsOptions<DataModel>,
) {
  const callIamApi = makeIamApiCaller(options);
  const { authenticatedAction } = options;

  return {
    setDefaultRole: authenticatedAction({
      args: { scopeId: v.string(), ...optionalRoleRef, idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/scopes/set-default-role", body);
      },
    }),

    createInvitation: authenticatedAction({
      args: {
        scopeId: v.string(),
        email: v.string(),
        roleIds: v.optional(v.array(v.string())),
        roleKeys: v.optional(v.array(v.string())),
        expiresInDays: v.optional(v.number()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          email: args.email,
          role_ids: args.roleIds,
          role_keys: args.roleKeys,
          expires_in_days: args.expiresInDays,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/invitations/create", body);
        return normalizeIamInvitationCreateResult(result);
      },
    }),

    revokeInvitation: authenticatedAction({
      args: {
        scopeId: v.string(),
        invitationId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          invitation_id: args.invitationId,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/invitations/revoke", body);
      },
    }),

    /**
     * Lists only roles the signed-in actor may assign at the exact target.
     * Use this for role pickers; `listScopeRoles` is the complete mirrored
     * catalog and can include roles the actor is not authorized to confer.
     * `subjectType` must match the intended user or group recipient.
     */
    listGrantableRoles: authenticatedAction({
      args: {
        scopeId: v.string(),
        subjectType: v.union(v.literal("user"), v.literal("group")),
        target: grantableRoleTargetValidator,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const target =
          args.target.type === "scope"
            ? { type: "scope" as const }
            : {
                type: "resource" as const,
                resource_type: args.target.resourceType,
                resource_id: args.target.resourceId,
                applies_to: args.target.appliesTo ?? "self",
              };
        const result = await callIamApi("/v1/iam/roles/list-grantable", {
          scope_id: args.scopeId,
          subject_type: args.subjectType,
          target,
          ...appUserActor(args.idToken),
        });
        return normalizeIamGrantableRoleListResult(result);
      },
    }),

    assignRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        ...optionalRoleRef,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/roles/assign", body);
      },
    }),

    removeRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        ...optionalRoleRef,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/roles/remove", body);
      },
    }),

    createOrgCustomRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        key: v.optional(v.string()),
        name: v.string(),
        description: v.optional(v.string()),
        permissionKeys: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          key: args.key,
          name: args.name,
          description: args.description,
          permission_keys: args.permissionKeys,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/roles/create-org-custom", body);
      },
    }),

    updateRolePermissions: authenticatedAction({
      args: {
        scopeId: v.string(),
        ...optionalRoleRef,
        permissionKeys: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          permission_keys: args.permissionKeys,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/roles/update-permissions", body);
      },
    }),

    setUserExceptions: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        allow: v.array(v.string()),
        deny: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          allow: args.allow,
          deny: args.deny,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/user-exceptions/set", body);
      },
    }),

    createResourceGrant: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        resourceType: v.string(),
        resourceId: v.string(),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireExactResource(args);
        requireExactResourceForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/resource-grants/create", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    replaceResourceGrants: authenticatedAction({
      args: {
        scopeId: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        subjects: v.array(resourceGrantSubjectReplacementValidator),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireExactResource(args);
        const body = {
          scope_id: args.scopeId,
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          subjects: resourceGrantReplacementSubjectsBody(args.subjects),
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/resource-grants/replace", body);
        return normalizeIamResourceGrantsReplaceResult(result);
      },
    }),

    replaceMemberRoles: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        roleKeys: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          role_keys: memberRoleReplacementKeysBody(args.roleKeys),
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/roles/replace", body);
        return normalizeIamMemberRolesReplaceResult(result);
      },
    }),

    createResourceInvitation: authenticatedAction({
      args: {
        scopeId: v.string(),
        email: v.string(),
        resourceType: v.string(),
        resourceId: v.string(),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresInDays: v.optional(v.number()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireExactResourceForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          email: args.email,
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_in_days: args.expiresInDays,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/invitations/create-resource", body);
        return normalizeIamInvitationCreateResult(result);
      },
    }),

    setResourcePermissionRule: authenticatedAction({
      args: {
        scopeId: v.string(),
        subject: resourceRuleSubjectValidator,
        resourceType: v.string(),
        target: resourceRuleTargetValidator,
        permissionKey: v.string(),
        effect: resourceRuleEffectValidator,
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          subject: resourceRuleSubjectBody(args.subject),
          resource_type: args.resourceType,
          target: resourceRuleTargetBody(args.target),
          permission_key: args.permissionKey,
          effect: args.effect,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/resource-rules/set", body);
      },
    }),

    setResourcePermissionRules: authenticatedAction({
      args: {
        scopeId: v.string(),
        subject: resourceRuleSubjectValidator,
        resourceType: v.string(),
        target: resourceRuleTargetValidator,
        appliesTo: v.optional(bindingAppliesToValidator),
        rules: v.array(
          v.object({
            permissionKey: v.string(),
            effect: resourceRuleReplacementEffectValidator,
            expiresAt: v.optional(v.union(v.string(), v.null())),
          }),
        ),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          subject: resourceRuleSubjectBody(args.subject),
          resource_type: args.resourceType,
          target: resourceRuleTargetBody(args.target),
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          rules: args.rules.map((rule) => ({
            permission_key: rule.permissionKey,
            effect: rule.effect,
            expires_at: rule.expiresAt,
          })),
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/resource-rules/replace", body);
      },
    }),

    revokeResourceGrant: authenticatedAction({
      args: { scopeId: v.string(), grantId: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          grant_id: args.grantId,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/resource-grants/revoke", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    setGrantExpiry: authenticatedAction({
      args: {
        scopeId: v.string(),
        grantId: v.string(),
        expiresAt: v.union(v.string(), v.null()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          grant_id: args.grantId,
          expires_at: args.expiresAt,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/expiries/set", body);
        return normalizeIamResourceGrantWriteResult(result);
      },
    }),

    setRoleOverride: authenticatedAction({
      args: {
        scopeId: v.string(),
        roleKey: v.string(),
        allow: v.array(v.string()),
        deny: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          role_key: args.roleKey,
          allow: args.allow,
          deny: args.deny,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/role-overrides/set", body);
      },
    }),

    // Adds a member to an organization scope, identified by their Hercules
    // Auth user id, with an optional role (the scope default role when
    // omitted). It also restores a previously removed or suspended member to
    // active.
    addMember: authenticatedAction({
      args: {
        scopeId: v.string(),
        herculesAuthUserId: v.string(),
        ...optionalRoleRef,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          hercules_auth_user_id: args.herculesAuthUserId,
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/members/add", body);
      },
    }),

    setMemberStatus: authenticatedAction({
      args: {
        scopeId: v.string(),
        principalId: v.string(),
        status: v.union(v.literal("active"), v.literal("suspended")),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          status: args.status,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/members/status", body);
      },
    }),

    removeMember: authenticatedAction({
      args: {
        scopeId: v.string(),
        principalId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/members/remove", body);
      },
    }),

    approveMember: authenticatedAction({
      args: {
        scopeId: v.string(),
        principalId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          principal_id: args.principalId,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/members/approve", body);
      },
    }),

    upsertAdmissionRule: authenticatedAction({
      args: {
        scopeId: v.string(),
        effect: v.union(v.literal("allow"), v.literal("deny")),
        subjectType: v.union(v.literal("email"), v.literal("domain")),
        subjectValue: v.string(),
        reason: v.optional(v.union(v.string(), v.null())),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          effect: args.effect,
          subject_type: args.subjectType,
          subject_value: args.subjectValue,
          reason: args.reason,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/admission-rules/upsert", body);
      },
    }),

    archiveAdmissionRule: authenticatedAction({
      args: { scopeId: v.string(), ruleId: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          rule_id: args.ruleId,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/admission-rules/archive", body);
      },
    }),

    setAccountEntryMode: authenticatedAction({
      args: {
        scopeId: v.string(),
        accountEntryMode: accountEntryModeValidator,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          account_entry_mode: args.accountEntryMode,
          ...appUserActor(args.idToken),
        };
        return await callIamApi("/v1/iam/entry-mode/set", body);
      },
    }),

    createGroup: authenticatedAction({
      args: { scopeId: v.string(), name: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          name: args.name,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/create", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    renameGroup: authenticatedAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        name: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          name: args.name,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/rename", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    // Archive is the group's terminal state and only removal path (no hard delete).
    archiveGroup: authenticatedAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/archive", body);
        return normalizeIamGroupWriteResult(result);
      },
    }),

    listGroups: authenticatedAction({
      args: {
        scopeId: v.string(),
        includeArchived: v.optional(v.boolean()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          include_archived: args.includeArchived,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/list", body);
        return normalizeIamGroupListResult(result);
      },
    }),

    addGroupMember: authenticatedAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        memberPrincipalId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          member_principal_id: args.memberPrincipalId,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/members/add", body);
        return normalizeIamGroupMemberWriteResult(result);
      },
    }),

    removeGroupMember: authenticatedAction({
      args: {
        scopeId: v.string(),
        groupPrincipalId: v.string(),
        memberPrincipalId: v.string(),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          group_principal_id: args.groupPrincipalId,
          member_principal_id: args.memberPrincipalId,
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/groups/members/remove", body);
        return normalizeIamGroupMemberWriteResult(result);
      },
    }),

    listResourceInvitations: authenticatedAction({
      args: { scopeId: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...appUserActor(args.idToken) };
        const result = await callIamApi("/v1/iam/invitations/list-resource", body);
        return normalizeIamResourceInvitationListResult(result);
      },
    }),

    getRoleOverrides: authenticatedAction({
      args: { scopeId: v.string(), ...optionalRoleRef, idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/role-overrides/get", body);
        return normalizeIamRoleOverridesResult(result);
      },
    }),

    getUserExceptions: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: iamRecipientValidator,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...appUserActor(args.idToken),
        };
        const result = await callIamApi("/v1/iam/user-exceptions/get", body);
        return normalizeIamUserExceptionsResult(result);
      },
    }),
  };
}

/**
 * Builds a public authenticated action for creating an organization scope.
 * `canCreateScope` is the app's product-policy gate. The authenticated caller
 * becomes the new scope's Owner automatically; do not add a separate self
 * role or resource grant.
 */
export function createIamScopeAction<DataModel extends GenericDataModel>(
  options: CreateIamScopeActionOptions<DataModel>,
) {
  return options.authenticatedAction({
    args: {
      name: v.string(),
      defaultRoleKey: v.optional(v.string()),
      accountEntryMode: v.optional(accountEntryModeValidator),
    },
    handler: async (ctx, args) => {
      const allowed = await options.canCreateScope(ctx, args);
      if (!allowed) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Access denied",
        });
      }

      return await createIamScope(ctx, args, options);
    },
  });
}

/**
 * Builds a public action that gives a newly created app resource's trusted
 * creator one fixed manager role, then marks the app row active.
 *
 * The browser supplies only `resourceId`. App-owned callbacks must load the
 * trusted creator and scope from the database and activate the same
 * provisioning row. The resource type, role, and descendant behavior are
 * static factory configuration, so callers cannot turn this into arbitrary
 * self-grant.
 *
 * Keep the resource unavailable while it is `provisioning`. If activation
 * fails after the grant, retrying is safe because the control-plane grant
 * write is idempotent. Once active, this action never recreates a removed
 * manager grant.
 */
export function createResourceCreatorBootstrapAction<DataModel extends GenericDataModel>(
  options: CreateResourceCreatorBootstrapActionOptions<DataModel>,
) {
  const callIamApi = makeIamApiCaller(options);

  return options.authenticatedAction({
    args: { resourceId: v.string() },
    handler: async (ctx, args): Promise<ResourceCreatorBootstrapResult> => {
      const identity = await ctx.auth.getUserIdentity();
      const actorHerculesAuthUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
      const target = await options.getBootstrapTarget(ctx, args);
      if (
        !target ||
        target.resourceId !== args.resourceId ||
        target.creatorHerculesAuthUserId !== actorHerculesAuthUserId
      ) {
        throwIamDenied();
      }

      const memberships = await options.listMyMemberships(ctx);
      const activeInTargetScope = memberships.some(
        (membership) => membership.scopeId === target.scopeId && membership.status === "active",
      );
      if (!activeInTargetScope) {
        throwIamDenied();
      }

      if (target.state === "active") {
        return {
          resourceId: target.resourceId,
          state: "active",
          bootstrapped: false,
        };
      }

      const result = await callIamApi("/v1/iam/resource-grants/create", {
        scope_id: target.scopeId,
        hercules_auth_user_id: actorHerculesAuthUserId,
        resource_type: options.resourceType,
        resource_id: target.resourceId,
        role_key: options.managerRoleKey,
        permission_key: undefined,
        applies_to: options.appliesTo,
        expires_at: undefined,
        ...serviceActor,
      });
      const grant = normalizeIamResourceGrantWriteResult(result);

      await options.activateResource(ctx, {
        resourceId: target.resourceId,
        creatorHerculesAuthUserId: actorHerculesAuthUserId,
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

/**
 * Creates an organization scope for the authenticated caller. Hercules derives
 * the caller from the Convex identity and makes that user Owner of the new
 * scope. The app should persist the returned `accessScopeId` on its
 * organization metadata row.
 */
export async function createIamScope(
  ctx: CreateIamScopeContext,
  args: CreateIamScopeArgs,
  options: IamApiOptions = {},
): Promise<IamScopeCreateResult> {
  const callIamApi = makeIamApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  const actorHerculesAuthUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
  const body = {
    name: args.name,
    default_role_key: args.defaultRoleKey,
    account_entry_mode: args.accountEntryMode,
    owner_hercules_auth_user_id: actorHerculesAuthUserId,
  };
  const result = await callIamApi("/v1/iam/scopes/create", body);
  return normalizeIamScopeCreateResult(result);
}

export async function createIamInvitation(
  args: CreateIamInvitationArgs,
  options: IamApiOptions = {},
): Promise<IamInvitationCreateResult> {
  const callIamApi = makeIamApiCaller(options);
  const body = {
    scope_id: args.scopeId,
    email: args.email,
    role_ids: args.roleIds,
    role_keys: args.roleKeys,
    expires_in_days: args.expiresInDays,
    ...serviceActor,
  };
  const result = await callIamApi("/v1/iam/invitations/create", body);
  return normalizeIamInvitationCreateResult(result);
}

/**
 * Invite an email to a single resource, conferring a custom role or a single
 * permission scoped to that resource (not the whole scope). Pass exactly one of
 * `roleKey` / `permissionKey`. This helper always acts as the internal service.
 * Public app-user invitations are exposed by
 * {@link createIamManagementActions}.
 */
export async function createResourceInvitation(
  args: CreateResourceInvitationArgs,
  options: IamApiOptions = {},
): Promise<IamInvitationCreateResult> {
  requireExactResourceForDescendants(args);
  const callIamApi = makeIamApiCaller(options);
  const body = {
    scope_id: args.scopeId,
    email: args.email,
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    role_key: args.roleKey,
    permission_key: args.permissionKey,
    ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
    expires_in_days: args.expiresInDays,
    ...serviceActor,
  };
  const result = await callIamApi("/v1/iam/invitations/create-resource", body);
  return normalizeIamInvitationCreateResult(result);
}

function requireExactResourceForDescendants(args: {
  appliesTo?: IamBindingAppliesTo;
  resourceId?: string | null;
}) {
  if (
    args.appliesTo === "self_and_descendants" &&
    (typeof args.resourceId !== "string" || args.resourceId.length === 0)
  ) {
    throw new Error('appliesTo "self_and_descendants" requires an exact resourceId.');
  }
}

function requireSpecificTargetForDescendants(args: {
  appliesTo?: IamBindingAppliesTo;
  target: { mode: "all" } | { mode: "specific"; resourceId: string };
}) {
  if (args.appliesTo === "self_and_descendants" && args.target.mode !== "specific") {
    throw new Error('appliesTo "self_and_descendants" requires a specific resource target.');
  }
}

export async function acceptIamInvitation(
  ctx: CreateIamScopeContext,
  args: AcceptIamInvitationArgs,
  options: IamApiOptions = {},
): Promise<IamInvitationAcceptResult> {
  const callIamApi = makeIamApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  requireTokenIdentifier(identity?.tokenIdentifier);
  const body = { token: args.token, id_token: normalizeIdToken(args.idToken) };
  const result = await callIamApi("/v1/iam/invitations/accept", body);
  return normalizeIamInvitationAcceptResult(result);
}

function makeIamApiCaller(options: IamApiOptions) {
  let client: IamSdkClient | undefined = options.client;

  return async (path: string, body: Record<string, unknown>): Promise<WriteResult> => {
    client ??= createSdkClient(options);
    return await client.post<WriteResult>(path, { body });
  };
}

function createSdkClient(options: IamApiOptions): IamSdkClient {
  const envVarName = options.apiKeyEnvVar ?? DEFAULT_IAM_API_KEY_ENV_VAR;
  const apiKey = options.apiKey ?? process.env[envVarName];
  if (!apiKey) {
    throw new Error(`${envVarName} is required for Hercules IAM API calls.`);
  }

  return new Hercules({
    apiKey,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  }) as unknown as IamSdkClient;
}

function appUserActor(idToken: string) {
  return {
    actor_mode: "app_user" as const,
    id_token: normalizeIdToken(idToken),
  };
}

// An OIDC ID token is a JWT: three dot-separated base64url segments. A bare
// user or subject id (for example user.profile.sub) has no dots, so a shape
// check here turns the most common token mix-up into an immediate developer
// error instead of a confusing control-plane 403.
const jwtShapePattern = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function normalizeIdToken(idToken: string): string {
  const normalizedIdToken = idToken.trim();
  if (!normalizedIdToken) {
    throw new ConvexError({
      code: "INVALID_ID_TOKEN",
      message: "idToken is required",
    });
  }
  if (!jwtShapePattern.test(normalizedIdToken)) {
    throw new ConvexError({
      code: "INVALID_ID_TOKEN",
      message:
        "idToken does not look like an OIDC ID token (a JWT with three dot-separated segments). " +
        "Pass the signed-in user's ID token (user.id_token), not a user or subject id such as user.profile.sub.",
    });
  }
  return normalizedIdToken;
}

function principalRef(recipient: IamRecipient) {
  return recipient.type === "user"
    ? { hercules_auth_user_id: recipient.herculesAuthUserId }
    : { principal_id: recipient.principalId };
}

function memberRoleReplacementKeysBody(roleKeys: string[]) {
  if (roleKeys.length > MAX_MEMBER_ROLE_REPLACEMENT_ENTRIES) {
    throw new Error(
      `At most ${MAX_MEMBER_ROLE_REPLACEMENT_ENTRIES} member roles can be replaced at once.`,
    );
  }
  return roleKeys;
}

function resourceGrantReplacementSubjectsBody(
  subjects: Array<{
    recipient: IamRecipient;
    grants: Array<{
      roleKey?: string;
      permissionKey?: string;
      appliesTo?: IamBindingAppliesTo;
      expiresAt?: string | null;
    }>;
  }>,
) {
  if (subjects.length < MIN_RESOURCE_GRANT_REPLACEMENT_SUBJECTS) {
    throw new Error(
      `At least ${MIN_RESOURCE_GRANT_REPLACEMENT_SUBJECTS} resource grant subject is required.`,
    );
  }
  if (subjects.length > MAX_RESOURCE_GRANT_REPLACEMENT_SUBJECTS) {
    throw new Error(
      `At most ${MAX_RESOURCE_GRANT_REPLACEMENT_SUBJECTS} resource grant subjects can be replaced at once.`,
    );
  }
  const grantCount = subjects.reduce((count, subject) => count + subject.grants.length, 0);
  if (grantCount > MAX_RESOURCE_GRANT_REPLACEMENT_ENTRIES) {
    throw new Error(
      `At most ${MAX_RESOURCE_GRANT_REPLACEMENT_ENTRIES} resource grants can be replaced at once. Split larger edits by subjects.`,
    );
  }
  return subjects.map((subject) => ({
    ...principalRef(subject.recipient),
    grants: subject.grants.map((grant) => ({
      role_key: grant.roleKey,
      permission_key: grant.permissionKey,
      applies_to: grant.appliesTo,
      expires_at: grant.expiresAt,
    })),
  }));
}

function requireExactResource(args: { resourceId?: string | null }) {
  if (typeof args.resourceId !== "string" || args.resourceId.trim().length === 0) {
    throw new Error("resourceId must identify one exact resource.");
  }
}

function roleRef(args: { roleId?: string; roleKey?: string }) {
  return { role_id: args.roleId, role_key: args.roleKey };
}

function resourceRuleSubjectBody(
  subject: { type: "principal"; principalId: string } | { type: "role"; roleKey: string },
) {
  return subject.type === "role"
    ? { type: "role" as const, role_key: subject.roleKey }
    : { type: "principal" as const, principal_id: subject.principalId };
}

function resourceRuleTargetBody(
  target: { mode: "all" } | { mode: "specific"; resourceId: string },
) {
  return target.mode === "all"
    ? { mode: "all" as const }
    : { mode: "specific" as const, resource_id: target.resourceId };
}

function parseTokenIdentifierSubject(tokenIdentifier: string | null | undefined): string {
  const value = requireTokenIdentifier(tokenIdentifier);
  const separatorIndex = value.lastIndexOf("|");
  return value.slice(separatorIndex + 1);
}

function requireTokenIdentifier(tokenIdentifier: string | null | undefined): string {
  if (!tokenIdentifier) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  return tokenIdentifier;
}

function throwIamDenied(): never {
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "Access denied",
  });
}

function normalizeIamScopeCreateResult(result: WriteResult): IamScopeCreateResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    created: optionalBoolean(result, "created", "created"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeIamResourceGrantWriteResult(result: WriteResult): IamResourceGrantWriteResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    grantId: requiredString(result, "grant_id", "grantId"),
    changed: requiredBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeIamResourceGrantsReplaceResult(
  result: WriteResult,
): IamResourceGrantsReplaceResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    resourceType: requiredString(result, "resource_type", "resourceType"),
    resourceId: requiredString(result, "resource_id", "resourceId"),
    subjects: requiredRecordArray(result, "subjects", "subjects").map((subject) => ({
      principalId: requiredString(subject, "principal_id", "subjects[].principalId"),
      grants: requiredRecordArray(subject, "grants", "subjects[].grants").map((grant) => ({
        grantId: requiredString(grant, "grant_id", "subjects[].grants[].grantId"),
        roleId: nullableString(grant, "role_id", "subjects[].grants[].roleId"),
        permissionId: nullableString(grant, "permission_id", "subjects[].grants[].permissionId"),
        appliesTo: optionalBindingAppliesTo(grant),
        expiresAt: nullableString(grant, "expires_at", "subjects[].grants[].expiresAt"),
      })),
    })),
    changed: requiredBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeIamMemberRolesReplaceResult(result: WriteResult): IamMemberRolesReplaceResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    principalId: requiredString(result, "principal_id", "principalId"),
    roleIds: requiredStringArray(result, "role_ids", "roleIds"),
    changed: requiredBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeIamInvitationCreateResult(result: WriteResult): IamInvitationCreateResult {
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

function normalizeIamInvitationAcceptResult(result: WriteResult): IamInvitationAcceptResult {
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

function normalizeIamGroupListResult(result: WriteResult): IamGroupListResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    groups: requiredRecordArray(result, "groups", "groups").map((group) => ({
      groupPrincipalId: requiredString(group, "group_principal_id", "groups[].groupPrincipalId"),
      name: nullableString(group, "name", "groups[].name"),
      memberCount: requiredNumber(group, "member_count", "groups[].memberCount"),
      archived: requiredBoolean(group, "archived", "groups[].archived"),
      archivedAt: nullableString(group, "archived_at", "groups[].archivedAt"),
      createdAt: requiredString(group, "created_at", "groups[].createdAt"),
      updatedAt: requiredString(group, "updated_at", "groups[].updatedAt"),
    })),
  };
}

function normalizeIamGrantableRoleListResult(result: WriteResult): IamGrantableRoleListResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    roles: requiredRecordArray(result, "roles", "roles").map((role) => {
      const roleKind = requiredString(role, "role_kind", "roles[].roleKind");
      if (roleKind !== "system" && roleKind !== "custom") {
        throw new Error("IAM API response has invalid roles[].roleKind.");
      }
      return {
        roleId: requiredString(role, "role_id", "roles[].roleId"),
        roleKey: requiredString(role, "role_key", "roles[].roleKey"),
        roleName: requiredString(role, "role_name", "roles[].roleName"),
        roleKind,
        shared: requiredBoolean(role, "shared", "roles[].shared"),
      };
    }),
  };
}

function normalizeIamGroupWriteResult(result: WriteResult): IamGroupWriteResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    groupPrincipalId: requiredString(result, "group_principal_id", "groupPrincipalId"),
    changed: optionalBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeIamGroupMemberWriteResult(result: WriteResult): IamGroupMemberWriteResult {
  return {
    ...normalizeIamGroupWriteResult(result),
    memberPrincipalId: requiredString(result, "member_principal_id", "memberPrincipalId"),
    membershipId: optionalString(result, "membership_id", "membershipId"),
  };
}

function normalizeIamResourceInvitationListResult(
  result: WriteResult,
): IamResourceInvitationListResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    invitations: requiredRecordArray(result, "invitations", "invitations").map((invitation) => ({
      invitationId: requiredString(invitation, "invitation_id", "invitations[].invitationId"),
      email: requiredString(invitation, "email", "invitations[].email"),
      resourceType: requiredString(invitation, "resource_type", "invitations[].resourceType"),
      resourceId: requiredString(invitation, "resource_id", "invitations[].resourceId"),
      conferralType: nullableConferralType(invitation),
      roleId: nullableString(invitation, "role_id", "invitations[].roleId"),
      permissionId: nullableString(invitation, "permission_id", "invitations[].permissionId"),
      appliesTo: optionalBindingAppliesTo(invitation),
      expiresAt: requiredString(invitation, "expires_at", "invitations[].expiresAt"),
      createdAt: requiredString(invitation, "created_at", "invitations[].createdAt"),
      updatedAt: requiredString(invitation, "updated_at", "invitations[].updatedAt"),
    })),
  };
}

function normalizeIamRoleOverridesResult(result: WriteResult): IamRoleOverridesResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    roleId: requiredString(result, "role_id", "roleId"),
    overrides: requiredRecordArray(result, "overrides", "overrides").map((override) => ({
      permissionId: requiredString(override, "permission_id", "overrides[].permissionId"),
      permissionKey: requiredString(override, "permission_key", "overrides[].permissionKey"),
      effect: requiredEffect(override, "effect", "overrides[].effect"),
    })),
  };
}

function normalizeIamUserExceptionsResult(result: WriteResult): IamUserExceptionsResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    principalId: requiredString(result, "principal_id", "principalId"),
    exceptions: requiredRecordArray(result, "exceptions", "exceptions").map((exception) => ({
      permissionId: requiredString(exception, "permission_id", "exceptions[].permissionId"),
      permissionKey: requiredString(exception, "permission_key", "exceptions[].permissionKey"),
      effect: requiredEffect(exception, "effect", "exceptions[].effect"),
      expiresAt: nullableString(exception, "expires_at", "exceptions[].expiresAt"),
    })),
  };
}

function normalizeIamDeploymentEntryResult(result: WriteResult): IamDeploymentEntryResult {
  return {
    allowed: requiredBoolean(result, "allowed", "allowed"),
    reason: requiredString(result, "reason", "reason"),
    principalId: optionalString(result, "principal_id", "principalId"),
    status: optionalIamEntryStatus(result),
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
    principalId: result.principalId,
    status: "active",
    stateVersion: result.stateVersion,
    changed: false,
  };
}

function requiredString(result: WriteResult, apiKey: string, resultName: string): string {
  const value = result[apiKey];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`IAM API response missing ${resultName}.`);
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
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

function requiredBoolean(result: WriteResult, apiKey: string, resultName: string): boolean {
  const value = result[apiKey];
  if (typeof value !== "boolean") {
    throw new Error(`IAM API response missing ${resultName}.`);
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
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

function optionalIamEntryStatus(result: WriteResult): IamDeploymentEntryResult["status"] {
  const value = result["status"];
  if (value === undefined || value === null) return undefined;
  if (
    value !== "active" &&
    value !== "blocked" &&
    value !== "suspended" &&
    value !== "pending_approval" &&
    value !== "removed"
  ) {
    throw new Error("IAM API response has invalid status.");
  }
  return value;
}

function requiredNumber(result: WriteResult, apiKey: string, resultName: string): number {
  const value = result[apiKey];
  if (typeof value !== "number") {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

function requiredStringArray(result: WriteResult, apiKey: string, resultName: string): string[] {
  const value = result[apiKey];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

function requiredRecordArray(
  result: WriteResult,
  apiKey: string,
  resultName: string,
): WriteResult[] {
  const value = result[apiKey];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))
  ) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value as WriteResult[];
}

function nullableString(result: WriteResult, apiKey: string, resultName: string): string | null {
  const value = result[apiKey];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

function requiredEffect(result: WriteResult, apiKey: string, resultName: string): "allow" | "deny" {
  const value = result[apiKey];
  if (value !== "allow" && value !== "deny") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

function optionalBindingAppliesTo(result: WriteResult): IamBindingAppliesTo {
  const value = result["applies_to"];
  if (value === undefined) return "self";
  if (value !== "self" && value !== "self_and_descendants") {
    throw new Error("IAM API response has invalid invitations[].appliesTo.");
  }
  return value;
}

function nullableConferralType(result: WriteResult): "role" | "permission" | null {
  const value = result["conferral_type"];
  if (value === undefined || value === null) return null;
  if (value !== "role" && value !== "permission") {
    throw new Error("IAM API response has invalid invitations[].conferralType.");
  }
  return value;
}
