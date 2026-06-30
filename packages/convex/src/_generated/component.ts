/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE MATCHES THE CONVEX-GENERATED COMPONENT API SHAPE.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { AccessProjectionSyncPayload, SyncResponse } from "../shared/sync";

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
  roleId: string;
  roleKey: string;
  roleName: string;
  isSystemRole: boolean;
  isRestricted: boolean;
};

type DirectRoleAssignment = RoleSummary & {
  assignmentId: string;
  expiresAt: number | null;
};

type TenantSummary = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

type TenantDetail = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  lifecycleStatus: "active" | "archived";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

type TenantUser = {
  userId: string;
  status: MembershipStatus;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

type TenantGroup = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
  memberCount: number;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

type RoleDetail = RoleSummary & {
  description: string | null;
  permissionKeys: string[];
};

type ResourceNode = {
  type: string;
  externalId: string;
  parent?: ResourceRef;
  data?: unknown;
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

type Page<K extends string, V> = { [P in K]: V[] } & { cursor?: string };

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
      Page<"tenants", TenantSummary>,
      Name
    >;
    listMyRoles: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      RoleSummary[],
      Name
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; sourceVersion: number },
      TargetTenantSyncStatus,
      Name
    >;
    getTenant: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      TenantDetail | null,
      Name
    >;
    listTenants: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; cursor?: string; limit?: number },
      Page<"tenants", TenantDetail>,
      Name
    >;
    listTenantUsers: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        tenantId?: string;
        cursor?: string;
        limit?: number;
        status?: MembershipStatus | "all";
      },
      Page<"users", TenantUser>,
      Name
    >;
    getTenantUser: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; userId: string },
      TenantUser | null,
      Name
    >;
    listTenantGroups: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; cursor?: string; limit?: number },
      Page<"groups", TenantGroup>,
      Name
    >;
    getTenantGroup: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; groupId: string },
      TenantGroup | null,
      Name
    >;
    listGroupMembers: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        tenantId?: string;
        groupId: string;
        cursor?: string;
        limit?: number;
      },
      Page<"users", TenantUser>,
      Name
    >;
    listTenantRoles: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      RoleSummary[],
      Name
    >;
    getTenantRole: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; roleId: string },
      RoleDetail | null,
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
      Page<"resources", ResourceNode>,
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
      { tenantId?: string; type: string; externalId: string; parent?: ResourceRef; data?: unknown },
      ResourceNode | null,
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
    applySync: FunctionReference<
      "mutation",
      "public",
      AccessProjectionSyncPayload,
      SyncResponse,
      Name
    >;
  };
};
