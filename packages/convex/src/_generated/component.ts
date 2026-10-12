/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE MATCHES THE CONVEX-GENERATED COMPONENT API SHAPE.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import type { SyncResponse } from "../shared/sync";

type ResourceRef = { type: string; externalId: string };

type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

type AccessDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  membershipId?: string;
};

type CheckArgs = {
  tokenIdentifier?: string;
  tenantId?: string;
  permission: string;
  resource?: ResourceRef;
};

type RoleSummary = {
  id: string;
  key: string;
  name: string;
  isAppScope: boolean;
  tenantId: string | null;
};

type GroupSummary = {
  id: string;
  name: string;
  status: "active" | "archived";
};

type TenantSummary = {
  id: string;
  name: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

type ResourceNode = {
  type: string;
  externalId: string;
  parent?: ResourceRef;
};

type TenantAccessStatus =
  | { kind: "principal"; membershipId: string; status: MembershipStatus; stateVersion: number }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "tenant_missing"
        | "membership_missing";
      stateVersion?: number;
    };

type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      membershipId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      membershipId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

// ── mirror-table record shapes (Convex system fields + sourceVersion dropped) ──
type TenantRecord = {
  id: string;
  name: string;
  isPrimaryTenant: boolean;
  status: "active" | "archived";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

type UserRecord = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  avatar?: string;
  phone?: string;
  phoneVerified: boolean;
  updatedAt: number;
};

type TenantMembershipRecord = {
  id: string;
  tenantId: string;
  userId: string;
  status: MembershipStatus;
  updatedAt: number;
};

type GroupRecord = {
  id: string;
  tenantId: string;
  description?: string;
  name: string;
  status: "active" | "archived";
  updatedAt: number;
};

type MemberRoleSummary = RoleSummary & { heldVia: "direct" | "group" };
type MemberUser = { id: string; name: string; email: string; avatar?: string };
type MemberSummary = {
  membershipId: string;
  status: MembershipStatus;
  user: MemberUser;
  roles: MemberRoleSummary[];
};
type MemberResourceRoleAssignment = {
  resource: ResourceRef;
  role: RoleSummary;
  heldVia: "direct" | "group";
};
type MemberDetail = MemberSummary & { resourceRoleAssignments: MemberResourceRoleAssignment[] };

type GroupMembershipRecord = {
  groupId: string;
  membershipId: string;
  tenantId: string;
  updatedAt: number;
};

type RoleRecord = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  tenantId: string | null;
  isAppScope: boolean;
  updatedAt: number;
};

type PermissionRecord = {
  id: string;
  key: string;
  isAppScope: boolean;
  updatedAt: number;
};

type RolePermissionRecord = {
  roleId: string;
  permissionId: string;
  updatedAt: number;
};

type ResourceTypeRecord = {
  id: string;
  key: string;
  name: string;
  parentResourceTypeId: string | null;
  updatedAt: number;
};

type UserRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  expiresAt?: number;
  updatedAt: number;
};

type GroupRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  groupId: string;
  roleId: string;
  expiresAt?: number;
  updatedAt: number;
};

type UserResourceRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  resourceTypeId: string;
  externalId: string;
  expiresAt?: number;
  updatedAt: number;
};

type GroupResourceRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  groupId: string;
  roleId: string;
  resourceTypeId: string;
  externalId: string;
  expiresAt?: number;
  updatedAt: number;
};

type ItemsPage<V> = { items: V[]; cursor?: string };

type ListQuery<Args extends DefaultFunctionArgs, V, Name> = FunctionReference<
  "query",
  "public",
  Args & { cursor?: string; limit?: number },
  ItemsPage<V>,
  Name
>;
type GetQuery<Args extends DefaultFunctionArgs, V, Name> = FunctionReference<
  "query",
  "public",
  Args,
  V | null,
  Name
>;

/**
 * A utility for referencing the Hercules IAM component's exposed API.
 *
 * Useful when expecting a parameter like `components.hercules`.
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  checks: {
    check: FunctionReference<"query", "public", CheckArgs, AccessDecision, Name>;
    checkMany: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; checks: Array<Omit<CheckArgs, "tokenIdentifier">> },
      AccessDecision[],
      Name
    >;
  };
  queries: {
    // Caller-centric reads (me.*) and sync status.
    getTenantAccessStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      TenantAccessStatus,
      Name
    >;
    listMyTenants: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; cursor?: string; limit?: number; status?: "active" | "all" },
      ItemsPage<TenantSummary>,
      Name
    >;
    listMyRoles: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      RoleSummary[],
      Name
    >;
    listMyGroups: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      GroupSummary[],
      Name
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; sourceVersion: number },
      TargetTenantSyncStatus,
      Name
    >;

    // Generic per-table reads (TRUSTED / UNGATED).
    tenantsList: ListQuery<
      { status?: "active" | "archived"; isPrimaryTenant?: boolean },
      TenantRecord,
      Name
    >;
    tenantsGet: GetQuery<{ id?: string; primary?: boolean }, TenantRecord, Name>;

    usersList: ListQuery<{ email?: string }, UserRecord, Name>;
    usersGet: GetQuery<{ id?: string; email?: string }, UserRecord, Name>;

    groupsList: ListQuery<{ tenantId?: string; status?: "active" | "archived" }, GroupRecord, Name>;
    groupsGet: GetQuery<{ id: string }, GroupRecord, Name>;

    rolesList: ListQuery<{ tenantId?: string | null; isAppScope?: boolean }, RoleRecord, Name>;
    rolesGet: GetQuery<{ id?: string; key?: string; tenantId?: string | null }, RoleRecord, Name>;

    permissionsList: ListQuery<{ isAppScope?: boolean }, PermissionRecord, Name>;
    permissionsGet: GetQuery<{ id?: string; key?: string }, PermissionRecord, Name>;

    resourceTypesList: ListQuery<
      { parentResourceTypeId?: string | null },
      ResourceTypeRecord,
      Name
    >;
    resourceTypesGet: GetQuery<{ id?: string; key?: string }, ResourceTypeRecord, Name>;

    tenantMembershipsList: ListQuery<
      { tenantId?: string; status?: MembershipStatus; userId?: string },
      TenantMembershipRecord,
      Name
    >;
    tenantMembershipsGet: GetQuery<
      { id?: string; tenantId?: string; userId?: string },
      TenantMembershipRecord,
      Name
    >;
    // Members directory (composed, TRUSTED like the table reads).
    membersList: ListQuery<{ tenantId?: string; status?: MembershipStatus }, MemberSummary, Name>;
    membersGet: GetQuery<{ tenantId?: string; membershipId: string }, MemberDetail, Name>;

    userRoleAssignmentsList: ListQuery<
      { tenantId?: string; membershipId?: string; roleId?: string },
      UserRoleAssignmentRecord,
      Name
    >;
    userRoleAssignmentsGet: GetQuery<{ id: string }, UserRoleAssignmentRecord, Name>;

    groupRoleAssignmentsList: ListQuery<
      { tenantId?: string; groupId?: string; roleId?: string },
      GroupRoleAssignmentRecord,
      Name
    >;
    groupRoleAssignmentsGet: GetQuery<{ id: string }, GroupRoleAssignmentRecord, Name>;

    userResourceRoleAssignmentsList: ListQuery<
      {
        tenantId?: string;
        membershipId?: string;
        roleId?: string;
        resourceTypeId?: string;
        externalId?: string;
      },
      UserResourceRoleAssignmentRecord,
      Name
    >;
    userResourceRoleAssignmentsGet: GetQuery<
      { id: string },
      UserResourceRoleAssignmentRecord,
      Name
    >;

    groupResourceRoleAssignmentsList: ListQuery<
      {
        tenantId?: string;
        groupId?: string;
        roleId?: string;
        resourceTypeId?: string;
        externalId?: string;
      },
      GroupResourceRoleAssignmentRecord,
      Name
    >;
    groupResourceRoleAssignmentsGet: GetQuery<
      { id: string },
      GroupResourceRoleAssignmentRecord,
      Name
    >;

    groupMembershipsList: ListQuery<
      { groupId?: string; membershipId?: string; tenantId?: string },
      GroupMembershipRecord,
      Name
    >;
    groupMembershipsGet: GetQuery<
      { groupId: string; membershipId: string },
      GroupMembershipRecord,
      Name
    >;

    rolePermissionsList: ListQuery<
      { roleId?: string; permissionId?: string },
      RolePermissionRecord,
      Name
    >;
    rolePermissionsGet: GetQuery<
      { roleId: string; permissionId: string },
      RolePermissionRecord,
      Name
    >;
  };
  resources: {
    list: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        tenantId?: string;
        type?: string;
        parent?: ResourceRef;
        permission?: string;
        cursor?: string;
        limit?: number;
      },
      ItemsPage<ResourceNode>,
      Name
    >;
    get: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        tenantId?: string;
        type: string;
        externalId: string;
        permission?: string;
      },
      ResourceNode | null,
      Name
    >;
    write: FunctionReference<
      "mutation",
      "public",
      { tenantId?: string; type: string; externalId: string; parent?: ResourceRef },
      ResourceNode,
      Name
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { tenantId?: string; type: string; externalId: string },
      { deleted: boolean },
      Name
    >;
  };
  sync: {
    // Public entry point for the signed sync channel. An ACTION that verifies
    // the standardwebhooks signature (against the component-bound secret) before
    // applying the internal mirror mutation. The raw apply (`applyProjection`)
    // is internal and intentionally absent from this public API.
    applySync: FunctionReference<
      "action",
      "public",
      { payload: string; webhookId: string; webhookTimestamp: string; webhookSignature: string },
      SyncResponse,
      Name
    >;
  };
};
