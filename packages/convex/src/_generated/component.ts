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
import type { AccessProjectionSyncPayload, ScopeKind, SyncResponse } from "../shared/sync";

type AuthorizationArgs = {
  tokenIdentifier?: string;
  scopeId?: string;
  permission?: string;
  // DL16 resource grant support. Optional; when present, authorize also
  // walks grants whose object is the specific resource. scopeFromResource
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

type ListMyMembershipsArgs = { tokenIdentifier?: string };
type GetDeploymentEntryStatusArgs = { tokenIdentifier?: string };
type ListMyRolesArgs = { tokenIdentifier?: string; scopeId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: AuthorizationAncestor[];
};
type ListScopeArgs = { tokenIdentifier?: string; scopeId: string };
type ListScopeMemberDirectoryArgs = ListScopeArgs & {
  cursor?: string;
  limit?: number;
};
type ListDirectSubjectsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType: string;
  resourceId: string;
  permission: string;
};

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

type ScopeMember = {
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
};

type ScopeMemberDirectoryEntry = {
  principalId: string;
  herculesAuthUserId: string;
  name: string;
  email: string;
  image?: string;
};

type ScopeMemberDirectoryPage = {
  members: ScopeMemberDirectoryEntry[];
  cursor?: string;
};

type ScopeRoleSummary = RoleSummary & { shared: boolean };

type ScopePermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

type DirectResourceSubject = {
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  name?: string;
  email?: string;
  image?: string;
  effect: "allow" | "deny";
  expiresAt?: number;
  roleId?: string;
  roleKey?: string;
  roleName?: string;
  permissionId?: string;
  permissionKey?: string;
};

type Membership = {
  scopeId: string;
  scopeName: string;
  kind: ScopeKind;
  roles: RoleSummary[];
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
};

type DeploymentEntryStatus =
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
        | "default_scope_missing"
        | "principal_missing";
      stateVersion?: number;
    };

type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  scopeId?: string;
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
 * A utility for referencing the Hercules Access Control component's exposed API.
 *
 * Useful when expecting a parameter like `components.hercules`.
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  checks: {
    authorize: FunctionReference<"query", "public", AuthorizationArgs, AuthorizationDecision, Name>;
  };
  queries: {
    getDeploymentEntryStatus: FunctionReference<
      "query",
      "public",
      GetDeploymentEntryStatusArgs,
      DeploymentEntryStatus,
      Name
    >;
    listMyMemberships: FunctionReference<
      "query",
      "public",
      ListMyMembershipsArgs,
      Membership[],
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
    listScopeMemberDirectory: FunctionReference<
      "query",
      "public",
      ListScopeMemberDirectoryArgs,
      ScopeMemberDirectoryPage,
      Name
    >;
    listScopeMembers: FunctionReference<"query", "public", ListScopeArgs, ScopeMember[], Name>;
    listScopeRoles: FunctionReference<"query", "public", ListScopeArgs, ScopeRoleSummary[], Name>;
    listScopePermissions: FunctionReference<
      "query",
      "public",
      ListScopeArgs,
      ScopePermissionSummary[],
      Name
    >;
    listDirectSubjectsForResource: FunctionReference<
      "query",
      "public",
      ListDirectSubjectsArgs,
      DirectResourceSubject[],
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
