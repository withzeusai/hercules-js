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

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
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
  permissions: string[];
};

/**
 * A utility for referencing the Hercules Access Control component's exposed API.
 *
 * Useful when expecting a parameter like `components.accessControl`.
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
