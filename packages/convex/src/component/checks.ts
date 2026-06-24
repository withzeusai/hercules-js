import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import {
  explainAccessResolution,
  hasExplicitDeny,
  type AccessResolution,
  type RequestedAccess,
} from "./authz";
import {
  evaluateEffectiveAccess,
  isSupersetAction,
  normalizeAuthorizationAncestors,
  type AuthorizationAncestor,
  type EffectiveAccessEvaluation,
} from "./effective";
import { parseTokenIdentifier } from "../shared/token";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// Public WITHIN the component boundary: a component's functions are never
// client-callable; only public functions are exported to the parent app, and
// these checks are exactly the parent-facing API (internal builders are NOT
// exported, so the SDK's runQuery would fail with "does not export").
const query = queryGeneric as QueryBuilder<DataModel, "public">;

// Mirrors client/index.ts PERMISSION_RESOURCE_TYPE_SENTINEL: the SDK's
// tenantFromResource extractor cannot know the canonical catalog resource type
// of the checked permission, so it sends this sentinel and the gate below
// substitutes the resolved permission's resourceType.
const PERMISSION_RESOURCE_TYPE_SENTINEL = "__hercules_permission_resource_type__";
const authorizationAncestorValidator = v.object({
  resourceType: v.string(),
  resourceId: v.string(),
});
const authorizationCheckValidator = v.object({
  tenantId: v.optional(v.string()),
  permission: v.string(),
  resourceType: v.optional(v.string()),
  resourceId: v.optional(v.string()),
  ancestors: v.optional(v.array(authorizationAncestorValidator)),
});

export type PermissionDecision = {
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
};

export type ResolvedPermission = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
};

export type PermissionDecisionDetails = {
  decision: PermissionDecision;
  resolvedPermission?: ResolvedPermission;
  evaluation?: EffectiveAccessEvaluation;
  request?: RequestedAccess;
  accessResolution?: AccessResolution;
};

type PermissionDecisionArgs = {
  tokenIdentifier?: string;
  tenantId?: string;
  permission: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: AuthorizationAncestor[];
};

export const authorize = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    permission: v.optional(v.string()),
    // DL16 resource grant support. When provided, authorize also walks
    // resource-object grants targeting this resource. App code passes these
    // via a tenant extractor when the permission applies to a specific row.
    resourceType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    ancestors: v.optional(v.array(authorizationAncestorValidator)),
  },
  handler: async (ctx, args) => {
    if (!args.tokenIdentifier) {
      return deny("missing_identity");
    }

    const token = parseTokenIdentifier(args.tokenIdentifier);
    if (!token) {
      return deny("invalid_identity");
    }

    const state = await ctx.db.query("sync_state").unique();

    // Authenticated mode (no permission requested): the SDK already
    // verified the JWT via Convex's auth provider before reaching us. If
    // the mirror has not bootstrapped yet (no projection sync delivered),
    // accept on token presence so cold-start flows like updateCurrentUser
    // work. The issuer-match sanity check kicks in as soon as the first
    // projection populates sync_state.
    if (!args.permission) {
      if (state && token.issuer !== state.expectedIssuer) {
        return deny("unexpected_issuer");
      }
      return allow(state?.sourceVersion ?? 0, undefined, []);
    }

    return evaluatePermissionDecision(ctx, {
      tokenIdentifier: args.tokenIdentifier,
      tenantId: args.tenantId,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      ancestors: args.ancestors,
    });
  },
});

export const authorizeMany = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    checks: v.array(authorizationCheckValidator),
  },
  handler: async (ctx, args) => {
    if (args.checks.length > 50) {
      throw new Error("authorizeMany accepts at most 50 checks");
    }

    return await Promise.all(
      args.checks.map((check) =>
        evaluatePermissionDecision(ctx, {
          tokenIdentifier: args.tokenIdentifier,
          ...check,
        }),
      ),
    );
  },
});

/**
 * Resolve a single permission request to an allow/deny decision. This is the
 * canonical permission gate, shared by the `authorize` query (the hot can()
 * path) and the tenant-admin list queries, so both apply identical wildcard,
 * deny-override, and owner-only-lever semantics. Reads only the local mirror.
 */
export async function evaluatePermissionDecision(
  ctx: GenericQueryCtx<DataModel>,
  args: PermissionDecisionArgs,
): Promise<PermissionDecision> {
  return (await evaluatePermissionDecisionDetailed(ctx, args)).decision;
}

export async function evaluatePermissionDecisionDetailed(
  ctx: GenericQueryCtx<DataModel>,
  args: PermissionDecisionArgs & { includeTrace?: boolean },
): Promise<PermissionDecisionDetails> {
  // Resolve the requested permission's canonical (resourceType, action) by
  // catalog lookup rather than parsing the key string. The producer ships
  // the structured columns verbatim, so this works for canonical
  // (app.appointments:create), dot-action (reports.export), and namespaced
  // keys alike without the runtime having to agree on slug grammar.
  // Catalog permissions are stored with the default scope row. Resolved
  // BEFORE the effective-access evaluation so the sentinel substitution below
  // feeds the canonical type into the resource-grant walk.
  const resolvedPermission = await findCatalogPermissionByKey(ctx, args.permission);

  // tenantFromResource defers its resource type to the checked permission (it
  // only sees the table row, not the catalog), so substitute the canonical
  // catalog resourceType for the sentinel. Explicit resource refs keep their
  // caller-provided type and the mismatch fence below.
  const resourceType =
    args.resourceType === PERMISSION_RESOURCE_TYPE_SENTINEL
      ? resolvedPermission?.resourceType
      : args.resourceType;
  const ancestors = normalizeAuthorizationAncestors(args.ancestors);
  if (ancestors === null) {
    return {
      decision: deny("invalid_request"),
      ...(resolvedPermission ? { resolvedPermission } : {}),
    };
  }

  const evaluation = await evaluateEffectiveAccess(ctx, {
    tokenIdentifier: args.tokenIdentifier,
    scopeId: args.tenantId,
    resourceType,
    resourceId: args.resourceId,
    ancestors,
    includeTrace: args.includeTrace,
  });
  if (!evaluation.allowed) {
    return {
      decision: deny(
        evaluation.reasonCode,
        evaluation.sourceVersion,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      ),
      ...(resolvedPermission ? { resolvedPermission } : {}),
      evaluation,
    };
  }

  if (!resolvedPermission) {
    return {
      decision: deny(
        "permission_missing",
        evaluation.sourceVersion,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      ),
      evaluation,
    };
  }

  // Requests carry concrete verbs only. A catalog permission whose action is
  // manage/* would map a request onto a superset token, which the algebra
  // does not special-case on the request side. Reject rather than evaluate.
  // enumeratePermissions filters the same keys out of getEffectivePermissions
  // (shared isSupersetAction), so the runtime never advertises a key this
  // gate would then deny.
  if (
    isSupersetAction(resolvedPermission.action) ||
    (resourceType !== undefined && resourceType !== resolvedPermission.resourceType)
  ) {
    return {
      decision: deny(
        "invalid_request",
        evaluation.sourceVersion,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      ),
      resolvedPermission,
      evaluation,
    };
  }

  const request: RequestedAccess = {
    resourceType: resolvedPermission.resourceType,
    action: resolvedPermission.action,
    classification: resolvedPermission.classification,
    objectId: args.resourceId,
  };
  const accessResolution = explainAccessResolution({
    wildcard: evaluation.wildcard,
    entries: evaluation.entries,
    request,
  });

  if (accessResolution.effect === "allow") {
    return {
      decision: allow(
        evaluation.sourceVersion ?? 0,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      ),
      resolvedPermission,
      evaluation,
      request,
      accessResolution,
    };
  }

  return {
    decision: deny(
      "permission_denied",
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
      hasExplicitDeny(evaluation.entries, request),
    ),
    resolvedPermission,
    evaluation,
    request,
    accessResolution,
  };
}

async function findCatalogPermissionByKey(ctx: GenericQueryCtx<DataModel>, key: string) {
  const defaultScope = await ctx.db
    .query("scopes")
    .withIndex("by_kind", (q) => q.eq("kind", "default"))
    .unique();
  if (!defaultScope) return null;
  return await ctx.db
    .query("permissions")
    .withIndex("by_scope_key", (q) =>
      q.eq("accessScopeId", defaultScope.accessScopeId).eq("key", key),
    )
    .unique();
}

function allow(
  sourceVersion: number,
  principalId: string | undefined,
  effectiveRoleIds: string[],
): PermissionDecision {
  return {
    allowed: true as const,
    reasonCode: "allowed",
    explicitDeny: false,
    sourceVersion,
    principalId,
    effectiveRoleIds,
  };
}

function deny(
  reasonCode: string,
  sourceVersion?: number,
  principalId?: string,
  effectiveRoleIds?: string[],
  explicitDeny = false,
): PermissionDecision {
  return {
    allowed: false as const,
    reasonCode,
    explicitDeny,
    sourceVersion,
    principalId,
    effectiveRoleIds: effectiveRoleIds ?? [],
  };
}
