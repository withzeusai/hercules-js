// IAM projection sync — v4 wire contract.
//
// This module is the consumer-side entry point for the signed projection sync
// channel. The wire shapes themselves live in `./projection-protocol` (the zod
// mirror of the producer's source of truth); this file re-exports them and adds
// the non-wire pieces the HTTP handler and the Convex component need:
//   • IAM_SYNC_PATH — the webhook route the producer posts to.
//   • SyncResponse — the mutation's response contract (mapped to HTTP statuses
//     by client/http.ts and consumed by the producer's reconciler).
//
// There is NO v2 compatibility: the old per-scope `scopes[].entities` + composite
// `changes` wire schema is gone. v4 carries a deployment-wide catalog + users at
// the top level and per-scope runtime state, with typed discriminated change
// identities (see projection-protocol.ts).

export const IAM_SYNC_PATH = "/_hercules/iam/sync";

// ── v4 wire schema + types (re-exported from the protocol mirror) ────────────
export {
  accessProjectionSyncPayloadSchema,
  accessProjectionSnapshotSchema,
  accessProjectionEventSchema,
  accessProjectionEffectSchema,
  accessProjectionApplicabilitySchema,
  accessProjectionWildcardModeSchema,
  accessProjectionPermissionClassificationSchema,
  accessProjectionScopeKindSchema,
  accessProjectionScopeStatusSchema,
  accessProjectionAccountEntryModeSchema,
  accessProjectionPrincipalStatusSchema,
  projectionUserSchema,
  projectionCatalogRoleSchema,
  projectionCatalogPermissionSchema,
  projectionCatalogRolePermissionSchema,
  projectionCatalogSchema,
  projectionScopeMetadataSchema,
  projectionPrincipalSchema,
  projectionPrincipalMembershipSchema,
  projectionScopeTenantRoleSchema,
  projectionScopeRolePermissionOverrideSchema,
  projectionScopeRoleBindingSchema,
  projectionScopePermissionBindingSchema,
  projectionScopeSchema,
  projectionScopeDeltaSchema,
  projectionCatalogDeltaSchema,
  projectionUserDeltaSchema,
} from "./projection-protocol";

export type {
  AccessProjectionSyncPayload,
  AccessProjectionSnapshot,
  AccessProjectionEvent,
  AccessProjectionEffect,
  AccessProjectionApplicability,
  AccessProjectionWildcardMode,
  AccessProjectionPermissionClassification,
  AccessProjectionScopeKind,
  AccessProjectionScopeStatus,
  AccessProjectionAccountEntryMode,
  AccessProjectionPrincipalStatus,
  ProjectionUser,
  ProjectionCatalogRole,
  ProjectionCatalogPermission,
  ProjectionCatalogRolePermission,
  ProjectionCatalog,
  ProjectionScopeMetadata,
  ProjectionPrincipal,
  ProjectionPrincipalMembership,
  ProjectionScopeTenantRole,
  ProjectionScopeRolePermissionOverride,
  ProjectionScopeRoleBinding,
  ProjectionScopePermissionBinding,
  ProjectionScope,
  ProjectionScopeDelta,
  ProjectionCatalogDelta,
  ProjectionUserDelta,
  ProjectionChange,
  ProjectionChangeOperation,
  ProjectionEntityType,
  ProjectionCatalogChange,
  ProjectionScopeChange,
} from "./projection-protocol";

// ── compatibility aliases for non-wire consumers ─────────────────────────────
// `ScopeKind` is imported by client/index.ts and the generated component shape.
// It is the same enum as the wire scope kind; alias it so those imports keep
// resolving without depending on the protocol module's longer name.
import type { AccessProjectionScopeKind } from "./projection-protocol";
export type ScopeKind = AccessProjectionScopeKind;

// ── mutation response contract ───────────────────────────────────────────────
// The `applySync` mutation returns one of these; client/http.ts maps them to
// HTTP statuses (200 applied/duplicate, 409 recoverable state conflicts, 400
// payload-shape problems). `unsupported_schema` is returned when a payload
// arrives at a schemaVersion this consumer does not implement.
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
      status:
        | "invalid_signature"
        | "invalid_payload"
        | "unsupported_schema"
        | "issuer_mismatch"
        | "default_scope_required";
    }
  | {
      ok: false;
      status: "not_ready" | "reset_required";
      currentVersion: number;
    };
