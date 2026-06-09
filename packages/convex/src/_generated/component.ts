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
type ListMyRolesArgs = { tokenIdentifier?: string; scopeId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType?: string;
  resourceId?: string;
};
type ListScopeArgs = { tokenIdentifier?: string; scopeId: string };
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
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
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
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval";
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
  status: "active" | "blocked" | "suspended" | "pending_approval";
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
    authorize: FunctionReference<
      "query",
      "internal",
      AuthorizationArgs,
      AuthorizationDecision,
      Name
    >;
  };
  queries: {
    listMyMemberships: FunctionReference<
      "query",
      "internal",
      ListMyMembershipsArgs,
      Membership[],
      Name
    >;
    listMyRoles: FunctionReference<"query", "internal", ListMyRolesArgs, RoleSummary[], Name>;
    getEffectivePermissions: FunctionReference<
      "query",
      "internal",
      GetEffectivePermissionsArgs,
      EffectivePermissionsResult,
      Name
    >;
    listScopeMembers: FunctionReference<"query", "internal", ListScopeArgs, ScopeMember[], Name>;
    listScopeRoles: FunctionReference<"query", "internal", ListScopeArgs, ScopeRoleSummary[], Name>;
    listScopePermissions: FunctionReference<
      "query",
      "internal",
      ListScopeArgs,
      ScopePermissionSummary[],
      Name
    >;
    listDirectSubjectsForResource: FunctionReference<
      "query",
      "internal",
      ListDirectSubjectsArgs,
      DirectResourceSubject[],
      Name
    >;
  };
  sync: {
    applySync: FunctionReference<
      "mutation",
      "internal",
      AccessProjectionSyncPayload,
      SyncResponse,
      Name
    >;
  };
};
