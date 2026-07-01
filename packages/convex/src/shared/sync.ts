// IAM projection sync — v5 wire contract.
//
// This module is the consumer-side entry point for the signed projection sync
// channel. The wire shapes themselves live in `./projection-protocol` (the zod
// mirror of the producer's source of truth); this file re-exports them and adds
// the non-wire pieces the HTTP handler and the Convex component need:
//   • IAM_SYNC_PATH — the webhook route the producer posts to.
//   • SyncResponse — the mutation's response contract (mapped to HTTP statuses
//     by client/http.ts and consumed by the producer's reconciler).

export const IAM_SYNC_PATH = "/_hercules/iam/sync";

// ── v5 wire schema + types (re-exported from the protocol mirror) ────────────
export {
  accessProjectionSyncPayloadSchema,
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
  accessProjectionTenantStatusSchema,
  accessProjectionGroupStatusSchema,
  accessProjectionAccountEntryModeSchema,
  accessProjectionMembershipStatusSchema,
  projectionTenantSchema,
  projectionRoleSchema,
  projectionPermissionSchema,
  projectionRolePermissionSchema,
  projectionResourceTypeSchema,
  projectionMembershipSchema,
  projectionGroupSchema,
  projectionGroupMembershipSchema,
  projectionUserRoleAssignmentSchema,
  projectionGroupRoleAssignmentSchema,
  projectionUserResourceRoleAssignmentSchema,
  projectionGroupResourceRoleAssignmentSchema,
  projectionUserSchema,
  projectionChangeSchema,
} from "./projection-protocol.js";

export type {
  AccessProjectionSyncPayload,
  AccessProjectionSnapshot,
  AccessProjectionEvent,
  AccessProjectionTenantStatus,
  AccessProjectionGroupStatus,
  AccessProjectionAccountEntryMode,
  AccessProjectionMembershipStatus,
  ProjectionTenant,
  ProjectionRole,
  ProjectionPermission,
  ProjectionRolePermission,
  ProjectionResourceType,
  ProjectionMembership,
  ProjectionGroup,
  ProjectionGroupMembership,
  ProjectionUserRoleAssignment,
  ProjectionGroupRoleAssignment,
  ProjectionUserResourceRoleAssignment,
  ProjectionGroupResourceRoleAssignment,
  ProjectionUser,
  ProjectionChange,
  ProjectionChangeOperation,
  ProjectionEntityType,
} from "./projection-protocol.js";

// ── sync response contract ───────────────────────────────────────────────────
// The component's `applySync` action returns one of these (after verifying the
// signature and applying the internal mirror mutation); client/http.ts maps
// them to HTTP statuses (200 applied/duplicate, 401 bad signature, 409
// recoverable state conflicts, 400 payload-shape problems). `unsupported_schema`
// is returned when a payload arrives at a schemaVersion this consumer does not
// implement.
export type SyncResponse =
  | { ok: true; status: "applied" | "duplicate"; acknowledgedVersion: number }
  | {
      ok: false;
      status: "version_gap";
      currentVersion: number;
      expectedVersion: number;
      receivedVersion: number;
    }
  | {
      ok: false;
      status: "invalid_signature" | "invalid_payload" | "unsupported_schema" | "issuer_mismatch";
    }
  | {
      ok: false;
      status: "not_ready" | "reset_required";
      currentVersion: number;
    };
