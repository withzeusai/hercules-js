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
};

type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
};

type ListMyMembershipsArgs = { tokenIdentifier?: string };

type Membership = {
  scopeId: string;
  scopeName: string;
  kind: ScopeKind;
  roleKey: string;
  roleName: string;
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval";
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
