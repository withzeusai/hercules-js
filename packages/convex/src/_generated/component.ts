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
import type { AccessProjectionSyncPayload, AccessTargetType, SyncResponse } from "../shared/sync";

type AuthorizationArgs = {
  tokenIdentifier?: string;
  permission?: string;
  targetType?: AccessTargetType;
  targetId?: string;
};

type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
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
  sync: {
    applySnapshot: FunctionReference<
      "mutation",
      "internal",
      AccessProjectionSyncPayload,
      SyncResponse,
      Name
    >;
  };
};
