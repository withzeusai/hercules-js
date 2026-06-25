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

type AuthorizationArgs = {
  tokenIdentifier?: string;
  tenantId?: string;
  permission?: string;
  // DL16 resource grant support. Optional; when present, authorize also
  // walks grants whose object is the specific resource. tenantFromResource
  // returns these via ensureAuthorized in the SDK client.
  resourceType?: string;
  resourceId?: string;
  ancestors?: AuthorizationAncestor[];
};

type AuthorizationAncestor = {
  resourceType: string;
  resourceId: string;
};

type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
};

type ListMyTenantsArgs = { tokenIdentifier?: string; cursor?: string; limit?: number };
type ListMyActiveTenantsArgs = ListMyTenantsArgs & {
  isDefault?: boolean;
};
type GetTargetTenantSyncStatusArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  sourceVersion: number;
};
type GetTenantAccessStatusArgs = { tokenIdentifier?: string };
type ListMyRolesArgs = { tokenIdentifier?: string; tenantId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: AuthorizationAncestor[];
};
type ListTenantArgs = { tokenIdentifier?: string; tenantId: string };
type ListTenantPageArgs = ListTenantArgs & {
  cursor?: string;
  limit?: number;
};
type ListTenantUserDirectoryArgs = ListTenantArgs & {
  cursor?: string;
  limit?: number;
};
type ListTenantMemberPickerUsersArgs = ListTenantArgs & {
  permission: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: AuthorizationAncestor[];
  cursor?: string;
  limit?: number;
};
type ListResourceSharingRecipientsArgs = ListTenantArgs & {
  permission: string;
  resourceType: string;
  resourceId: string;
  ancestors?: AuthorizationAncestor[];
  recipientType: "user" | "group";
  cursor?: string;
  limit?: number;
};
type ListDirectSubjectsArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  cursor?: string;
  limit?: number;
};

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

type TenantDirectRoleGrant = RoleSummary & {
  grantId: string;
  type: "role";
  expiresAt: number | null;
};

type TenantUser = {
  userId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleGrants: TenantDirectRoleGrant[];
};

type TenantGroup = {
  groupId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  memberCount: number;
  name?: string;
  roles: RoleSummary[];
  directRoleGrants: TenantDirectRoleGrant[];
};

type TenantUserDirectoryEntry = {
  userId: string;
  name: string;
  email: string;
  image?: string;
  roles: RoleSummary[];
};

type TenantUserDirectoryPage = {
  users: TenantUserDirectoryEntry[];
  cursor?: string;
};

type TenantMemberPickerUser = {
  userId: string;
  name: string;
  email: string;
  image?: string;
};

type TenantMemberPickerUsersPage = {
  users: TenantMemberPickerUser[];
  cursor?: string;
};

type SharingRecipient =
  | {
      type: "user";
      userId: string;
      name: string;
      email: string;
      image?: string;
    }
  | {
      type: "group";
      groupId: string;
      name?: string;
    };

type SharingRecipientsPage = {
  recipients: SharingRecipient[];
  cursor?: string;
};

type TenantRoleSummary = RoleSummary & { shared: boolean };

type TenantPermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

type DirectResourceRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourcePermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourceSubjectBase = {
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  name?: string;
  email?: string;
  image?: string;
};

type DirectResourceSubject = DirectResourceSubjectBase &
  ({ type: "user"; userId: string } | { type: "group"; groupId: string }) &
  (
    | { grant: DirectResourceRoleGrant; role: RoleSummary }
    | { grant: DirectResourcePermissionGrant }
  );

type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isDefault: boolean;
  roles: RoleSummary[];
  joinedAt: number;
  accessStatus: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  lifecycleStatus: "active" | "archived";
};

type ActiveTenantSummary = Omit<TenantSummary, "accessStatus" | "lifecycleStatus"> & {
  accessStatus: "active";
  lifecycleStatus: "active";
};

type TargetTenantSyncStatus =
  | {
      state: "syncing";
      currentSourceVersion?: number;
      targetSourceVersion: number;
    }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      principalId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      principalId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

type TenantDetail = {
  tenantId: string;
  tenantName: string;
  isDefault: boolean;
  lifecycleStatus: "active" | "archived";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

type TenantRolePermission = TenantPermissionSummary & {
  effect: "allow" | "deny";
};

type TenantRoleDetail = TenantRoleSummary & {
  description: string | null;
  basePermissions: TenantRolePermission[];
  tenantOverrides: TenantRolePermission[];
  effectivePermissions: TenantPermissionSummary[];
};

type ResourcePermissionOverrideSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

type ResourcePermissionOverrideTarget = { type: "all" } | { type: "resource"; resourceId: string };

type ResourcePermissionOverridesResult = {
  tenantId: string;
  subject: ResourcePermissionOverrideSubject;
  resourceType: string;
  target: ResourcePermissionOverrideTarget;
  grants: DirectResourcePermissionGrant[];
};

type ExplainAccessTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      ancestors?: AuthorizationAncestor[];
    };

type ExplainAccessGrantSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

type ExplainAccessGrantSource = {
  grantId: string;
  grantType: "role" | "permission";
  subject: ExplainAccessGrantSubject;
  roleId?: string;
  permissionId?: string;
  permissionKey?: string;
  effect: "allow" | "deny";
  target: { type: "tenant" } | { type: "resource"; resourceType: string; resourceId?: string };
  appliesTo: "self" | "self_and_descendants";
  expiresAt: number | null;
  inherited: boolean;
};

type ExplainAccessEntryOrigin =
  | { kind: "role_permission"; roleId: string }
  | {
      kind: "permission_grant";
      grantId: string;
      subject: ExplainAccessGrantSubject;
      inherited: boolean;
    }
  | {
      kind: "resource_role";
      grantId: string;
      roleId: string;
      subject: ExplainAccessGrantSubject;
      inherited: boolean;
    };

type ExplainAccessResult = {
  tenantId: string;
  userId: string;
  permission: string;
  target: ExplainAccessTarget;
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  decisiveReason: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
  sources: {
    directGrants: ExplainAccessGrantSource[];
    groupMemberships: Array<{
      groupId: string;
      groupName?: string;
      status?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
      active: boolean;
    }>;
    roles: Array<{
      roleId: string;
      roleKey: string;
      roleName: string;
      description: string | null;
      wildcard: "none" | "immutable" | "default";
      permissionEffect: "allow" | "deny" | null;
      grantIds: string[];
      viaGroupIds: string[];
    }>;
    roleOverrides: Array<{
      roleId: string;
      permissionId: string;
      permissionKey: string;
      effect: "allow" | "deny";
    }>;
    resourceGrants: ExplainAccessGrantSource[];
    ancestorGrants: ExplainAccessGrantSource[];
    explicitDenies: Array<{
      resourceType: string;
      action: string;
      objectType: "tenant" | "resource";
      objectId?: string;
      source?: ExplainAccessEntryOrigin;
    }>;
    expiredIgnoredGrants: ExplainAccessGrantSource[];
  };
};

type TenantAccessStatus =
  | {
      kind: "principal";
      principalId: string;
      status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
      stateVersion: number;
    }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "default_tenant_missing"
        | "principal_missing";
      stateVersion?: number;
    };

type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  tenantId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  // §0b: the principal's resolved wildcard mode. Under the wildcard model
  // `permissions` is a projection over the unbounded catalog (Owner = whole
  // catalog, Admin = catalog minus Owner-only levers), so callers should treat
  // a non-"none" mode as future-inclusive rather than exhaustive.
  wildcard: "none" | "immutable" | "default";
  permissions: string[];
};

/**
 * A utility for referencing the Hercules IAM component's exposed API.
 *
 * Useful when expecting a parameter like `components.hercules`.
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  checks: {
    authorize: FunctionReference<"query", "public", AuthorizationArgs, AuthorizationDecision, Name>;
    authorizeMany: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        checks: Array<Omit<AuthorizationArgs, "tokenIdentifier"> & { permission: string }>;
      },
      AuthorizationDecision[],
      Name
    >;
  };
  queries: {
    getTenantAccessStatus: FunctionReference<
      "query",
      "public",
      GetTenantAccessStatusArgs,
      TenantAccessStatus,
      Name
    >;
    listMyTenants: FunctionReference<
      "query",
      "public",
      ListMyTenantsArgs,
      { tenants: TenantSummary[]; cursor?: string },
      Name
    >;
    listMyActiveTenants: FunctionReference<
      "query",
      "public",
      ListMyActiveTenantsArgs,
      { tenants: ActiveTenantSummary[]; cursor?: string },
      Name
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      GetTargetTenantSyncStatusArgs,
      TargetTenantSyncStatus,
      Name
    >;
    listMyRoles: FunctionReference<"query", "public", ListMyRolesArgs, RoleSummary[], Name>;
    getEffectivePermissions: FunctionReference<
      "query",
      "public",
      GetEffectivePermissionsArgs,
      EffectivePermissionsResult,
      Name
    >;
    getTenant: FunctionReference<"query", "public", ListTenantArgs, TenantDetail | null, Name>;
    listTenantUserDirectory: FunctionReference<
      "query",
      "public",
      ListTenantUserDirectoryArgs,
      TenantUserDirectoryPage,
      Name
    >;
    listTenantMemberPickerUsers: FunctionReference<
      "query",
      "public",
      ListTenantMemberPickerUsersArgs,
      TenantMemberPickerUsersPage,
      Name
    >;
    listResourceSharingRecipients: FunctionReference<
      "query",
      "public",
      ListResourceSharingRecipientsArgs,
      SharingRecipientsPage,
      Name
    >;
    getTenantUserDirectoryEntry: FunctionReference<
      "query",
      "public",
      ListTenantArgs & { userId: string },
      TenantUserDirectoryEntry | null,
      Name
    >;
    listTenantUsers: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs,
      { users: TenantUser[]; cursor?: string },
      Name
    >;
    listTenantGroups: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs,
      { groups: TenantGroup[]; cursor?: string },
      Name
    >;
    listGroupMembers: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs & { groupId: string },
      { users: TenantUser[]; cursor?: string },
      Name
    >;
    listUserGroups: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs & { userId: string },
      { groups: TenantGroup[]; cursor?: string },
      Name
    >;
    listTenantRoles: FunctionReference<
      "query",
      "public",
      ListTenantArgs,
      TenantRoleSummary[],
      Name
    >;
    getTenantRole: FunctionReference<
      "query",
      "public",
      ListTenantArgs & { roleId: string },
      TenantRoleDetail | null,
      Name
    >;
    listTenantPermissions: FunctionReference<
      "query",
      "public",
      ListTenantArgs,
      TenantPermissionSummary[],
      Name
    >;
    getResourcePermissionOverrides: FunctionReference<
      "query",
      "public",
      ListTenantArgs & {
        subject: ResourcePermissionOverrideSubject;
        resourceType: string;
        target: ResourcePermissionOverrideTarget;
      },
      ResourcePermissionOverridesResult | null,
      Name
    >;
    explainAccess: FunctionReference<
      "query",
      "public",
      ListTenantArgs & {
        userId: string;
        permission: string;
        target: ExplainAccessTarget;
      },
      ExplainAccessResult | null,
      Name
    >;
    listDirectSubjectsForResource: FunctionReference<
      "query",
      "public",
      ListDirectSubjectsArgs,
      { subjects: DirectResourceSubject[]; cursor?: string },
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
