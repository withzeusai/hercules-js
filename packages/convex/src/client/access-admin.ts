"use node";

import { Hercules } from "@usehercules/sdk";
import type { ActionBuilder, GenericDataModel } from "convex/server";
import { ConvexError, v } from "convex/values";

const DEFAULT_API_VERSION = "2025-12-09";
const DEFAULT_ACCESS_ADMIN_API_KEY_ENV_VAR = "HERCULES_API_KEY";

type WriteResult = Record<string, unknown>;
export type AccessBindingAppliesTo = "self" | "self_and_descendants";

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
  status?: "active" | "blocked" | "suspended" | "pending_approval";
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
  overrides: Array<{ permissionId: string; permissionKey: string; effect: "allow" | "deny" }>;
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
  AccessAdminApiOptions & { internalAction: ActionBuilder<DataModel, "internal"> };

export type CreateAccessUserActionsOptions<DataModel extends GenericDataModel> =
  AccessAdminApiOptions & { authenticatedAction: ActionBuilder<DataModel, "public"> };

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
  auth: { getUserIdentity(): Promise<{ tokenIdentifier?: string | null } | null> };
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

const optionalRoleRef = { roleId: v.optional(v.string()), roleKey: v.optional(v.string()) };

const accountEntryModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);
const bindingAppliesToValidator = v.union(
  v.literal("self"),
  v.literal("self_and_descendants"),
);

/**
 * Builds the managed Access Control write actions (assign/remove roles,
 * invite, create org custom roles, resource grants, overrides, expiries,
 * member lifecycle, admission rules, entry mode, and groups) plus the raw
 * reads backing them (group/resource-invitation lists, role overrides, user
 * exceptions). Each one calls the Hercules control plane, so it needs the
 * `HERCULES_API_KEY` secret. Wire it once in `convex/accessAdmin.ts` and
 * re-export the actions you use.
 *
 * These are internal service-authority actions. Do not re-export them as public
 * Convex actions. Use {@link createAccessUserActions} for public resource
 * management by signed-in app users.
 */
export function createAccessAdminActions<DataModel extends GenericDataModel>(
  options: CreateAccessAdminActionsOptions<DataModel>,
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
        const body = { scope_id: args.scopeId, ...roleRef(args), ...serviceActor };
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
        const body = { scope_id: args.scopeId, invitation_id: args.invitationId, ...serviceActor };
        return await callAccessControlApi("/v1/access-control/invitations/revoke", body);
      },
    }),

    assignRole: internalAction({
      args: { scopeId: v.string(), ...optionalPrincipalRef, ...optionalRoleRef },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          ...roleRef(args),
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/roles/assign", body);
      },
    }),

    removeRole: internalAction({
      args: { scopeId: v.string(), ...optionalPrincipalRef, ...optionalRoleRef },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
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
      args: { scopeId: v.string(), ...optionalRoleRef, permissionKeys: v.array(v.string()) },
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
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/user-exceptions/set", body);
      },
    }),

    createResourceGrant: internalAction({
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        resourceType: v.string(),
        resourceId: v.optional(v.union(v.string(), v.null())),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        requireExactResourceForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          resource_type: args.resourceType,
          resource_id: args.resourceId ?? null,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/resource-grants/create", body);
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
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
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
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/resource-rules/set", body);
      },
    }),

    revokeResourceGrant: internalAction({
      args: { scopeId: v.string(), grantId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, grant_id: args.grantId, ...serviceActor };
        return await callAccessControlApi("/v1/access-control/resource-grants/revoke", body);
      },
    }),

    setGrantExpiry: internalAction({
      args: { scopeId: v.string(), grantId: v.string(), expiresAt: v.union(v.string(), v.null()) },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          grant_id: args.grantId,
          expires_at: args.expiresAt,
          ...serviceActor,
        };
        return await callAccessControlApi("/v1/access-control/expiries/set", body);
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
      args: { scopeId: v.string(), herculesAuthUserId: v.string(), ...optionalRoleRef },
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
        const body = { scope_id: args.scopeId, principal_id: args.principalId, ...serviceActor };
        return await callAccessControlApi("/v1/access-control/members/remove", body);
      },
    }),

    approveMember: internalAction({
      args: { scopeId: v.string(), principalId: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, principal_id: args.principalId, ...serviceActor };
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
        const body = { scope_id: args.scopeId, rule_id: args.ruleId, ...serviceActor };
        return await callAccessControlApi("/v1/access-control/admission-rules/archive", body);
      },
    }),

    setAccountEntryMode: internalAction({
      args: { scopeId: v.string(), accountEntryMode: accountEntryModeValidator },
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
        const body = { scope_id: args.scopeId, name: args.name, ...serviceActor };
        const result = await callAccessControlApi("/v1/access-control/groups/create", body);
        return normalizeAccessGroupWriteResult(result);
      },
    }),

    renameGroup: internalAction({
      args: { scopeId: v.string(), groupPrincipalId: v.string(), name: v.string() },
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
      args: { scopeId: v.string(), groupPrincipalId: v.string(), memberPrincipalId: v.string() },
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
      args: { scopeId: v.string(), groupPrincipalId: v.string(), memberPrincipalId: v.string() },
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
        const body = { scope_id: args.scopeId, ...roleRef(args), ...serviceActor };
        const result = await callAccessControlApi("/v1/access-control/role-overrides/get", body);
        return normalizeAccessRoleOverridesResult(result);
      },
    }),

    getUserExceptions: internalAction({
      args: { scopeId: v.string(), ...optionalPrincipalRef },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...principalRef(args), ...serviceActor };
        const result = await callAccessControlApi("/v1/access-control/user-exceptions/get", body);
        return normalizeAccessUserExceptionsResult(result);
      },
    }),
  };
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
export function createAccessUserActions<DataModel extends GenericDataModel>(
  options: CreateAccessUserActionsOptions<DataModel>,
) {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const { authenticatedAction } = options;

  return {
    enterDeployment: authenticatedAction({
      args: { idToken: v.string() },
      handler: async (_ctx, args) => {
        const result = await callAccessControlApi("/v1/access-control/entry", {
          id_token: normalizeIdToken(args.idToken),
        });
        return normalizeAccessDeploymentEntryResult(result);
      },
    }),

    setDefaultRole: authenticatedAction({
      args: { scopeId: v.string(), ...optionalRoleRef, idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = { scope_id: args.scopeId, ...roleRef(args), ...appUserActor(args.idToken) };
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
      args: { scopeId: v.string(), invitationId: v.string(), idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          invitation_id: args.invitationId,
          ...appUserActor(args.idToken),
        };
        return await callAccessControlApi("/v1/access-control/invitations/revoke", body);
      },
    }),

    assignRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        ...optionalRoleRef,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          ...roleRef(args),
          ...appUserActor(args.idToken),
        };
        return await callAccessControlApi("/v1/access-control/roles/assign", body);
      },
    }),

    removeRole: authenticatedAction({
      args: {
        scopeId: v.string(),
        ...optionalPrincipalRef,
        ...optionalRoleRef,
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
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
        ...optionalPrincipalRef,
        allow: v.array(v.string()),
        deny: v.array(v.string()),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
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
        ...optionalPrincipalRef,
        resourceType: v.string(),
        resourceId: v.optional(v.union(v.string(), v.null())),
        roleKey: v.optional(v.string()),
        permissionKey: v.optional(v.string()),
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireExactResourceForDescendants(args);
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          resource_type: args.resourceType,
          resource_id: args.resourceId ?? null,
          role_key: args.roleKey,
          permission_key: args.permissionKey,
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...appUserActor(args.idToken),
        };
        return await callAccessControlApi("/v1/access-control/resource-grants/create", body);
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
        appliesTo: v.optional(bindingAppliesToValidator),
        expiresAt: v.optional(v.union(v.string(), v.null())),
        idToken: v.string(),
      },
      handler: async (_ctx, args) => {
        requireSpecificTargetForDescendants(args);
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
          ...(args.appliesTo ? { applies_to: args.appliesTo } : {}),
          expires_at: args.expiresAt,
          ...appUserActor(args.idToken),
        };
        return await callAccessControlApi("/v1/access-control/resource-rules/set", body);
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
        return await callAccessControlApi("/v1/access-control/resource-grants/revoke", body);
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
        return await callAccessControlApi("/v1/access-control/expiries/set", body);
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
      args: { scopeId: v.string(), principalId: v.string(), idToken: v.string() },
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
      args: { scopeId: v.string(), principalId: v.string(), idToken: v.string() },
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
        const body = { scope_id: args.scopeId, name: args.name, ...appUserActor(args.idToken) };
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
      args: { scopeId: v.string(), groupPrincipalId: v.string(), idToken: v.string() },
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
      args: { scopeId: v.string(), includeArchived: v.optional(v.boolean()), idToken: v.string() },
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
        const body = { scope_id: args.scopeId, ...roleRef(args), ...appUserActor(args.idToken) };
        const result = await callAccessControlApi("/v1/access-control/role-overrides/get", body);
        return normalizeAccessRoleOverridesResult(result);
      },
    }),

    getUserExceptions: authenticatedAction({
      args: { scopeId: v.string(), ...optionalPrincipalRef, idToken: v.string() },
      handler: async (_ctx, args) => {
        const body = {
          scope_id: args.scopeId,
          ...principalRef(args),
          ...appUserActor(args.idToken),
        };
        const result = await callAccessControlApi("/v1/access-control/user-exceptions/get", body);
        return normalizeAccessUserExceptionsResult(result);
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
      accountEntryMode: v.optional(accountEntryModeValidator),
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
    owner_hercules_auth_user_id: actorHerculesAuthUserId,
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
    ...serviceActor,
  };
  const result = await callAccessControlApi("/v1/access-control/invitations/create", body);
  return normalizeAccessInvitationCreateResult(result);
}

/**
 * Invite an email to a single resource, conferring a custom role or a single
 * permission scoped to that resource (not the whole scope). Pass exactly one of
 * `roleKey` / `permissionKey`. This helper always acts as the internal service.
 * Public app-user invitations are exposed by {@link createAccessUserActions}.
 */
export async function createResourceInvitation(
  args: CreateResourceInvitationArgs,
  options: AccessAdminApiOptions = {},
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
  options: AccessAdminApiOptions = {},
): Promise<AccessInvitationAcceptResult> {
  const callAccessControlApi = makeAccessControlApiCaller(options);
  const identity = await ctx.auth.getUserIdentity();
  requireTokenIdentifier(identity?.tokenIdentifier);
  const body = { token: args.token, id_token: normalizeIdToken(args.idToken) };
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

function appUserActor(idToken: string) {
  return { actor_mode: "app_user" as const, id_token: normalizeIdToken(idToken) };
}

// An OIDC ID token is a JWT: three dot-separated base64url segments. A bare
// user or subject id (for example user.profile.sub) has no dots, so a shape
// check here turns the most common token mix-up into an immediate developer
// error instead of a confusing control-plane 403.
const jwtShapePattern = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function normalizeIdToken(idToken: string): string {
  const normalizedIdToken = idToken.trim();
  if (!normalizedIdToken) {
    throw new ConvexError({ code: "INVALID_ID_TOKEN", message: "idToken is required" });
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

function principalRef(args: { principalId?: string; herculesAuthUserId?: string }) {
  return { principal_id: args.principalId, hercules_auth_user_id: args.herculesAuthUserId };
}

function roleRef(args: { roleId?: string; roleKey?: string }) {
  return { role_id: args.roleId, role_key: args.roleKey };
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
    value !== "pending_approval"
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
