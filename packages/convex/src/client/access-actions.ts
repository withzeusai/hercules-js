import { Hercules } from "@usehercules/sdk";
import type { ActionBuilder, GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { AccessDeploymentEntryMirrorResult, Membership, ScopeRoleSummary } from "./index";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_ACCESS_CONTROL_API_KEY_ENV_VAR = "HERCULES_API_KEY";

type WriteResult = Record<string, unknown>;
export type AccessBindingAppliesTo = "self" | "self_and_descendants";

export type AccessResourceGrantWriteResult = {
  accessScopeId: string;
  grantId: string;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessResourceGrantsReplaceResult = {
  accessScopeId: string;
  resourceType: string;
  resourceId: string;
  subjects: Array<{
    principalId: string;
    grants: Array<{
      grantId: string;
      roleId: string | null;
      permissionId: string | null;
      appliesTo: AccessBindingAppliesTo;
      expiresAt: string | null;
    }>;
  }>;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessMemberRolesReplaceResult = {
  accessScopeId: string;
  principalId: string;
  roleIds: string[];
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessGrantableRoleTarget =
  | { type: "scope" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      appliesTo?: AccessBindingAppliesTo;
    };

export type AccessGrantableRoleListResult = {
  accessScopeId: string;
  roles: ScopeRoleSummary[];
};

export type AccessScopeCreateResult = {
  accessScopeId: string;
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

export type AccessDeploymentEntryResult = {
  allowed: boolean;
  reason: string;
  principalId?: string;
  status?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  stateVersion: number;
  changed: boolean;
};

export type AccessGroupListResult = {
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

export type AccessGroupWriteResult = {
  accessScopeId: string;
  groupPrincipalId: string;
  changed?: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type AccessGroupMemberWriteResult = AccessGroupWriteResult & {
  memberPrincipalId: string;
  membershipId?: string;
};

export type AccessResourceInvitationListResult = {
  accessScopeId: string;
  invitations: Array<{
    invitationId: string;
    email: string;
    resourceType: string;
    resourceId: string;
    conferralType: "role" | "permission" | null;
    roleId: string | null;
    permissionId: string | null;
    appliesTo: AccessBindingAppliesTo;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type AccessRoleOverridesResult = {
  accessScopeId: string;
  roleId: string;
  overrides: Array<{
    permissionId: string;
    permissionKey: string;
    effect: "allow" | "deny";
  }>;
};

export type AccessUserExceptionsResult = {
  accessScopeId: string;
  principalId: string;
  exceptions: Array<{
    permissionId: string;
    permissionKey: string;
    effect: "allow" | "deny";
    expiresAt: string | null;
  }>;
};

export type AccessControlSdkClient = {
  post<T>(path: string, options: { body: Record<string, unknown> }): Promise<T>;
};

export type AccessControlApiOptions = {
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: AccessControlSdkClient;
};

export type CreateAccessServiceActionsOptions<DataModel extends GenericDataModel> =
  AccessControlApiOptions & {
    internalAction: ActionBuilder<DataModel, "internal">;
  };

export type CreateAccessManagementActionsOptions<DataModel extends GenericDataModel> =
  AccessControlApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
  };

export type CreateDeploymentEntryActionOptions<DataModel extends GenericDataModel> =
  AccessControlApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    getDeploymentEntryStatus?: (
      ctx: GenericActionCtx<DataModel>,
    ) => Promise<AccessDeploymentEntryMirrorResult>;
  };

// The full admission-policy surface the entry evaluator handles.
export type AccessAccountEntryMode =
  | "open"
  | "allowlisted_only"
  | "invite_only"
  | "approval_required";

export type CreateAccessScopeArgs = {
  name: string;
  defaultRoleKey?: string;
  accountEntryMode?: AccessAccountEntryMode;
};

export type CreateAccessInvitationArgs = {
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
  appliesTo?: AccessBindingAppliesTo;
  expiresInDays?: number;
};

export type AcceptAccessInvitationArgs = {
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

export type CreateAccessScopeContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null>;
  };
};

export type CreateAccessScopeActionOptions<DataModel extends GenericDataModel> =
  AccessControlApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    canCreateScope: (
      ctx: CreateAccessScopeContext,
      args: CreateAccessScopeArgs,
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
      grant: AccessResourceGrantWriteResult;
    };

export type CreateResourceCreatorBootstrapActionOptions<DataModel extends GenericDataModel> =
  AccessControlApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
    resourceType: string;
    managerRoleKey: string;
    appliesTo: AccessBindingAppliesTo;
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
        grant: AccessResourceGrantWriteResult;
      },
    ) => Promise<void>;
  };

export type AccessRecipient =
  | { type: "user"; herculesAuthUserId: string }
  | { type: "principal"; principalId: string };

const accessRecipientValidator = v.union(
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
  recipient: accessRecipientValidator,
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
 * Builds the managed Access Control write actions (assign/remove roles,
 * invite, create org custom roles, resource grants, overrides, expiries,
 * member lifecycle, admission rules, entry mode, and groups) plus the raw
 * reads backing them (group/resource-invitation lists, role overrides, user
 * exceptions). Each one calls the Hercules control plane, so it needs the
 * `HERCULES_API_KEY` secret. Wire it in an internal `convex/accessService.ts`
 * module only when the app needs trusted service automation, and re-export
 * only the actions that workflow uses.
 *
 * These are internal service-authority actions. Do not re-export them as public
 * Convex actions. Use {@link createAccessManagementActions} for public resource
 * management by signed-in app users.
 */
export function createAccessServiceActions<DataModel extends GenericDataModel>(
  options: CreateAccessServiceActionsOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const { internalAction } = options;

  return {
    archiveScope: internalAction({
      args: { scopeId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId };
        return await callAccessControlApi("/v1/access-control/scopes/archive", body);
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
        return await callAccessControlApi("/v1/access-control/scopes/set-default-role", body);
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
        const result = await createAccessInvitation(args, options);
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
        return await callAccessControlApi("/v1/access-control/invitations/revoke", body);
      },
    }),

    assignRole: internalAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/roles/assign", body);
      },
    }),

    removeRole: internalAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
        ...optionalRoleRef,
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...roleRef(args),
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/roles/remove", body);
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
        return await callAccessControlApi("/v1/access-control/roles/create-org-custom", body);
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
        return await callAccessControlApi("/v1/access-control/roles/update-permissions", body);
      },
    }),

    setUserExceptions: internalAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        return await callAccessControlApi("/v1/access-control/user-exceptions/set", body);
      },
    }),

    createResourceGrant: internalAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/create",
          body,
        );
        return normalizeAccessResourceGrantWriteResult(result);
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/replace",
          body,
        );
        return normalizeAccessResourceGrantsReplaceResult(result);
      },
    }),

    replaceMemberRoles: internalAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
        roleKeys: v.array(v.string()),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          role_keys: memberRoleReplacementKeysBody(args.roleKeys),
          ...serviceActor,
        };
        const result = await callAccessControlApi("/v1/access-control/roles/replace", body);
        return normalizeAccessMemberRolesReplaceResult(result);
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
        return await callAccessControlApi("/v1/access-control/resource-rules/set", body);
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
        return await callAccessControlApi("/v1/access-control/resource-rules/replace", body);
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/revoke",
          body,
        );
        return normalizeAccessResourceGrantWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/expiries/set", body);
        return normalizeAccessResourceGrantWriteResult(result);
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
        return await callAccessControlApi("/v1/access-control/role-overrides/set", body);
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
        return await callAccessControlApi("/v1/access-control/members/add", body);
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
        return await callAccessControlApi("/v1/access-control/members/status", body);
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
        return await callAccessControlApi("/v1/access-control/members/remove", body);
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
        return await callAccessControlApi("/v1/access-control/members/approve", body);
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
        return await callAccessControlApi("/v1/access-control/admission-rules/upsert", body);
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
        return await callAccessControlApi("/v1/access-control/admission-rules/archive", body);
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
        return await callAccessControlApi("/v1/access-control/entry-mode/set", body);
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
        const result = await callAccessControlApi("/v1/access-control/groups/create", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/rename", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/archive", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/list", body);
        return normalizeAccessGroupListResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/members/add", body);
        return normalizeAccessGroupMemberWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/members/remove", body);
        return normalizeAccessGroupMemberWriteResult(result);
      },
    }),

    listResourceInvitations: internalAction({
      args: { scopeId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...serviceActor };
        const result = await callAccessControlApi(
          "/v1/access-control/invitations/list-resource",
          body,
        );
        return normalizeAccessResourceInvitationListResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/role-overrides/get", body);
        return normalizeAccessRoleOverridesResult(result);
      },
    }),

    getUserExceptions: internalAction({
      args: { scopeId: v.string(), recipient: accessRecipientValidator },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...serviceActor,
        };
        const result = await callAccessControlApi("/v1/access-control/user-exceptions/get", body);
        return normalizeAccessUserExceptionsResult(result);
      },
    }),
  };
}

/**
 * Builds the deployment-admission action used by the managed auth callback.
 * Keep this in the baseline access module so apps do not instantiate the full
 * access-management action collection only to enter a deployment.
 */
export function createDeploymentEntryAction<DataModel extends GenericDataModel>(
  options: CreateDeploymentEntryActionOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);

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

      const result = await callAccessControlApi("/v1/access-control/entry", {
        id_token: idToken,
      });
      return normalizeAccessDeploymentEntryResult(result);
    },
  });
}

/**
 * Builds authenticated public actions for end-user access management. The
 * control plane verifies the supplied ID token and applies the operation's
 * scope, Owner, or resource-level RBAC gate.
 *
 * Every action's `idToken` argument must be the signed-in user's OIDC ID token
 * (`user.id_token`): a JWT with three dot-separated segments. Never pass a user
 * or subject id (for example `user.profile.sub`); the SDK rejects values that
 * are not JWT-shaped before calling the API.
 */
export function createAccessManagementActions<DataModel extends GenericDataModel>(
  options: CreateAccessManagementActionsOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);
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
        return await callAccessControlApi("/v1/access-control/scopes/set-default-role", body);
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
        const result = await callAccessControlApi("/v1/access-control/invitations/create", body);
        return normalizeAccessInvitationCreateResult(result);
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
        return await callAccessControlApi("/v1/access-control/invitations/revoke", body);
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
        const result = await callAccessControlApi("/v1/access-control/roles/list-grantable", {
          scope_id: args.scopeId,
          subject_type: args.subjectType,
          target,
          ...appUserActor(args.idToken),
        });
        return normalizeAccessGrantableRoleListResult(result);
      },
    }),

    assignRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        return await callAccessControlApi("/v1/access-control/roles/assign", body);
      },
    }),

    removeRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        return await callAccessControlApi("/v1/access-control/roles/remove", body);
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
        return await callAccessControlApi("/v1/access-control/roles/create-org-custom", body);
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
        return await callAccessControlApi("/v1/access-control/roles/update-permissions", body);
      },
    }),

    setUserExceptions: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        return await callAccessControlApi("/v1/access-control/user-exceptions/set", body);
      },
    }),

    createResourceGrant: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/create",
          body,
        );
        return normalizeAccessResourceGrantWriteResult(result);
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/replace",
          body,
        );
        return normalizeAccessResourceGrantsReplaceResult(result);
      },
    }),

    replaceMemberRoles: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
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
        const result = await callAccessControlApi("/v1/access-control/roles/replace", body);
        return normalizeAccessMemberRolesReplaceResult(result);
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
        const result = await callAccessControlApi(
          "/v1/access-control/invitations/create-resource",
          body,
        );
        return normalizeAccessInvitationCreateResult(result);
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
        return await callAccessControlApi("/v1/access-control/resource-rules/set", body);
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
        return await callAccessControlApi("/v1/access-control/resource-rules/replace", body);
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
        const result = await callAccessControlApi(
          "/v1/access-control/resource-grants/revoke",
          body,
        );
        return normalizeAccessResourceGrantWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/expiries/set", body);
        return normalizeAccessResourceGrantWriteResult(result);
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
        return await callAccessControlApi("/v1/access-control/role-overrides/set", body);
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
        return await callAccessControlApi("/v1/access-control/members/add", body);
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
        return await callAccessControlApi("/v1/access-control/members/status", body);
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
        return await callAccessControlApi("/v1/access-control/members/remove", body);
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
        return await callAccessControlApi("/v1/access-control/members/approve", body);
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
        return await callAccessControlApi("/v1/access-control/admission-rules/upsert", body);
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
        return await callAccessControlApi("/v1/access-control/admission-rules/archive", body);
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
        return await callAccessControlApi("/v1/access-control/entry-mode/set", body);
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
        const result = await callAccessControlApi("/v1/access-control/groups/create", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/rename", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/archive", body);
        return normalizeAccessGroupWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/list", body);
        return normalizeAccessGroupListResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/members/add", body);
        return normalizeAccessGroupMemberWriteResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/groups/members/remove", body);
        return normalizeAccessGroupMemberWriteResult(result);
      },
    }),

    listResourceInvitations: authenticatedAction({
      args: { scopeId: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...appUserActor(args.idToken) };
        const result = await callAccessControlApi(
          "/v1/access-control/invitations/list-resource",
          body,
        );
        return normalizeAccessResourceInvitationListResult(result);
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
        const result = await callAccessControlApi("/v1/access-control/role-overrides/get", body);
        return normalizeAccessRoleOverridesResult(result);
      },
    }),

    getUserExceptions: authenticatedAction({
      args: {
        scopeId: v.string(),
        recipient: accessRecipientValidator,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args.recipient),
          ...appUserActor(args.idToken),
        };
        const result = await callAccessControlApi("/v1/access-control/user-exceptions/get", body);
        return normalizeAccessUserExceptionsResult(result);
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
export function createAccessScopeAction<DataModel extends GenericDataModel>(
  options: CreateAccessScopeActionOptions<DataModel>,
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

      return await createAccessScope(ctx, args, options);
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
  const callAccessControlApi = makeAccessControlApiCaller(options);

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
        throwAccessDenied();
      }

      const memberships = await options.listMyMemberships(ctx);
      const activeInTargetScope = memberships.some(
        (membership) => membership.scopeId === target.scopeId && membership.status === "active",
      );
      if (!activeInTargetScope) {
        throwAccessDenied();
      }

      if (target.state === "active") {
        return {
          resourceId: target.resourceId,
          state: "active",
          bootstrapped: false,
        };
      }

      const result = await callAccessControlApi("/v1/access-control/resource-grants/create", {
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
      const grant = normalizeAccessResourceGrantWriteResult(result);

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
export async function createAccessScope(
  ctx: CreateAccessScopeContext,
  args: CreateAccessScopeArgs,
  options: AccessControlApiOptions = {},
): Promise<AccessScopeCreateResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  const actorHerculesAuthUserId = parseTokenIdentifierSubject(identity?.tokenIdentifier);
  const body = {
    name: args.name,
    default_role_key: args.defaultRoleKey,
    account_entry_mode: args.accountEntryMode,
    owner_hercules_auth_user_id: actorHerculesAuthUserId,
  };
  const result = await callAccessControlApi("/v1/access-control/scopes/create", body);
  return normalizeAccessScopeCreateResult(result);
}

export async function createAccessInvitation(
  args: CreateAccessInvitationArgs,
  options: AccessControlApiOptions = {},
): Promise<AccessInvitationCreateResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const body = {
    scope_id: args.scopeId,
    email: args.email,
    role_ids: args.roleIds,
    role_keys: args.roleKeys,
    expires_in_days: args.expiresInDays,
    ...serviceActor,
  };
  const result = await callAccessControlApi("/v1/access-control/invitations/create", body);
  return normalizeAccessInvitationCreateResult(result);
}

/**
 * Invite an email to a single resource, conferring a custom role or a single
 * permission scoped to that resource (not the whole scope). Pass exactly one of
 * `roleKey` / `permissionKey`. This helper always acts as the internal service.
 * Public app-user invitations are exposed by
 * {@link createAccessManagementActions}.
 */
export async function createResourceInvitation(
  args: CreateResourceInvitationArgs,
  options: AccessControlApiOptions = {},
): Promise<AccessInvitationCreateResult> {
  requireExactResourceForDescendants(args);
  const callAccessControlApi = makeAccessControlApiCaller(options);
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
  const result = await callAccessControlApi("/v1/access-control/invitations/create-resource", body);
  return normalizeAccessInvitationCreateResult(result);
}

function requireExactResourceForDescendants(args: {
  appliesTo?: AccessBindingAppliesTo;
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
  appliesTo?: AccessBindingAppliesTo;
  target: { mode: "all" } | { mode: "specific"; resourceId: string };
}) {
  if (args.appliesTo === "self_and_descendants" && args.target.mode !== "specific") {
    throw new Error('appliesTo "self_and_descendants" requires a specific resource target.');
  }
}

export async function acceptAccessInvitation(
  ctx: CreateAccessScopeContext,
  args: AcceptAccessInvitationArgs,
  options: AccessControlApiOptions = {},
): Promise<AccessInvitationAcceptResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  requireTokenIdentifier(identity?.tokenIdentifier);
  const body = { token: args.token, id_token: normalizeIdToken(args.idToken) };
  const result = await callAccessControlApi("/v1/access-control/invitations/accept", body);
  return normalizeAccessInvitationAcceptResult(result);
}

function makeAccessControlApiCaller(options: AccessControlApiOptions) {
  let client: AccessControlSdkClient | undefined = options.client;

  return async (path: string, body: Record<string, unknown>): Promise<WriteResult> => {
    client ??= createSdkClient(options);
    return await client.post<WriteResult>(path, { body });
  };
}

function createSdkClient(options: AccessControlApiOptions): AccessControlSdkClient {
  const envVarName = options.apiKeyEnvVar ?? DEFAULT_ACCESS_CONTROL_API_KEY_ENV_VAR;
  const apiKey = options.apiKey ?? process.env[envVarName];
  if (!apiKey) {
    throw new Error(`${envVarName} is required for Hercules Access Control API calls.`);
  }

  return new Hercules({
    apiKey,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  }) as unknown as AccessControlSdkClient;
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

function principalRef(recipient: AccessRecipient) {
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
    recipient: AccessRecipient;
    grants: Array<{
      roleKey?: string;
      permissionKey?: string;
      appliesTo?: AccessBindingAppliesTo;
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

function throwAccessDenied(): never {
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "Access denied",
  });
}

function normalizeAccessScopeCreateResult(result: WriteResult): AccessScopeCreateResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    created: optionalBoolean(result, "created", "created"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeAccessResourceGrantWriteResult(
  result: WriteResult,
): AccessResourceGrantWriteResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    grantId: requiredString(result, "grant_id", "grantId"),
    changed: requiredBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeAccessResourceGrantsReplaceResult(
  result: WriteResult,
): AccessResourceGrantsReplaceResult {
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

function normalizeAccessMemberRolesReplaceResult(
  result: WriteResult,
): AccessMemberRolesReplaceResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    principalId: requiredString(result, "principal_id", "principalId"),
    roleIds: requiredStringArray(result, "role_ids", "roleIds"),
    changed: requiredBoolean(result, "changed", "changed"),
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

function normalizeAccessGroupListResult(result: WriteResult): AccessGroupListResult {
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

function normalizeAccessGrantableRoleListResult(
  result: WriteResult,
): AccessGrantableRoleListResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    roles: requiredRecordArray(result, "roles", "roles").map((role) => {
      const roleKind = requiredString(role, "role_kind", "roles[].roleKind");
      if (roleKind !== "system" && roleKind !== "custom") {
        throw new Error("Access Control API response has invalid roles[].roleKind.");
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

function normalizeAccessGroupWriteResult(result: WriteResult): AccessGroupWriteResult {
  return {
    accessScopeId: requiredString(result, "access_scope_id", "accessScopeId"),
    groupPrincipalId: requiredString(result, "group_principal_id", "groupPrincipalId"),
    changed: optionalBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

function normalizeAccessGroupMemberWriteResult(result: WriteResult): AccessGroupMemberWriteResult {
  return {
    ...normalizeAccessGroupWriteResult(result),
    memberPrincipalId: requiredString(result, "member_principal_id", "memberPrincipalId"),
    membershipId: optionalString(result, "membership_id", "membershipId"),
  };
}

function normalizeAccessResourceInvitationListResult(
  result: WriteResult,
): AccessResourceInvitationListResult {
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

function normalizeAccessRoleOverridesResult(result: WriteResult): AccessRoleOverridesResult {
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

function normalizeAccessUserExceptionsResult(result: WriteResult): AccessUserExceptionsResult {
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

function normalizeAccessDeploymentEntryResult(result: WriteResult): AccessDeploymentEntryResult {
  return {
    allowed: requiredBoolean(result, "allowed", "allowed"),
    reason: requiredString(result, "reason", "reason"),
    principalId: optionalString(result, "principal_id", "principalId"),
    status: optionalAccessEntryStatus(result),
    stateVersion: requiredNumber(result, "state_version", "stateVersion"),
    changed: requiredBoolean(result, "changed", "changed"),
  };
}

function activeDeploymentEntryResultFromMirror(result: {
  principalId: string;
  stateVersion: number;
}): AccessDeploymentEntryResult {
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

function requiredBoolean(result: WriteResult, apiKey: string, resultName: string): boolean {
  const value = result[apiKey];
  if (typeof value !== "boolean") {
    throw new Error(`Access Control API response missing ${resultName}.`);
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

function optionalAccessEntryStatus(result: WriteResult): AccessDeploymentEntryResult["status"] {
  const value = result["status"];
  if (value === undefined || value === null) return undefined;
  if (
    value !== "active" &&
    value !== "blocked" &&
    value !== "suspended" &&
    value !== "pending_approval" &&
    value !== "removed"
  ) {
    throw new Error("Access Control API response has invalid status.");
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
    throw new Error(`Access Control API response missing ${resultName}.`);
  }
  return value as WriteResult[];
}

function nullableString(result: WriteResult, apiKey: string, resultName: string): string | null {
  const value = result[apiKey];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Access Control API response has invalid ${resultName}.`);
  }
  return value;
}

function requiredEffect(result: WriteResult, apiKey: string, resultName: string): "allow" | "deny" {
  const value = result[apiKey];
  if (value !== "allow" && value !== "deny") {
    throw new Error(`Access Control API response has invalid ${resultName}.`);
  }
  return value;
}

function optionalBindingAppliesTo(result: WriteResult): AccessBindingAppliesTo {
  const value = result["applies_to"];
  if (value === undefined) return "self";
  if (value !== "self" && value !== "self_and_descendants") {
    throw new Error("Access Control API response has invalid invitations[].appliesTo.");
  }
  return value;
}

function nullableConferralType(result: WriteResult): "role" | "permission" | null {
  const value = result["conferral_type"];
  if (value === undefined || value === null) return null;
  if (value !== "role" && value !== "permission") {
    throw new Error("Access Control API response has invalid invitations[].conferralType.");
  }
  return value;
}
