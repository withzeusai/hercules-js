import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { evaluateAccess, hasExplicitDeny } from "./authz";
import {
  evaluateEffectiveAccess,
  isSupersetAction,
  normalizeAuthorizationAncestors,
  type AuthorizationAncestor,
} from "./effective";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// Public WITHIN the component boundary: a component's functions are never
// client-callable; only public functions are exported to the parent app, and
// these checks are exactly the parent-facing API (internal builders are NOT
// exported, so the SDK's runQuery would fail with "does not export").
const query = queryGeneric as QueryBuilder<DataModel, "public">;

// Mirrors client/index.ts PERMISSION_RESOURCE_TYPE_SENTINEL: the SDK's
// scopeFromResource extractor cannot know the canonical catalog resource type
// of the checked permission, so it sends this sentinel and the gate below
// substitutes the resolved permission's resourceType.
const PERMISSION_RESOURCE_TYPE_SENTINEL = "__hercules_permission_resource_type__";
const authorizationAncestorValidator = v.object({
  resourceType: v.string(),
  resourceId: v.string(),
});

export const authorize = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    scopeId: v.optional(v.string()),
    permission: v.optional(v.string()),
    // DL16 resource grant support. When provided, authorize also walks
    // resource-object grants targeting this resource. App code passes these
    // via a scope extractor when the permission applies to a specific row.
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
      scopeId: args.scopeId,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      ancestors: args.ancestors,
    });
  },
});

/**
 * Resolve a single permission request to an allow/deny decision. This is the
 * canonical permission gate, shared by the `authorize` query (the hot can()
 * path) and the scope-admin list queries, so both apply identical wildcard,
 * deny-override, and owner-only-lever semantics. Reads only the local mirror.
 */
export async function evaluatePermissionDecision(
  ctx: GenericQueryCtx<DataModel>,
  args: {
    tokenIdentifier?: string;
    scopeId?: string;
    permission: string;
    resourceType?: string;
    resourceId?: string;
    ancestors?: AuthorizationAncestor[];
  },
) {
  // Resolve the requested permission's canonical (resourceType, action) by
  // catalog lookup rather than parsing the key string. The producer ships
  // the structured columns verbatim, so this works for canonical
  // (app.appointments:create), dot-action (reports.export), and namespaced
  // keys alike without the runtime having to agree on slug grammar.
  // Catalog permissions always live in the default scope (DL15). Resolved
  // BEFORE the effective-access evaluation so the sentinel substitution below
  // feeds the canonical type into the resource-grant walk.
  const resolvedPermission = await findCatalogPermissionByKey(ctx, args.permission);

  // scopeFromResource defers its resource type to the checked permission (it
  // only sees the table row, not the catalog), so substitute the canonical
  // catalog resourceType for the sentinel. Explicit resource refs keep their
  // caller-provided type and the mismatch fence below.
  const resourceType =
    args.resourceType === PERMISSION_RESOURCE_TYPE_SENTINEL
      ? resolvedPermission?.resourceType
      : args.resourceType;
  const ancestors = normalizeAuthorizationAncestors(args.ancestors);
  if (ancestors === null) {
    return deny("invalid_request");
  }

  const evaluation = await evaluateEffectiveAccess(ctx, {
    tokenIdentifier: args.tokenIdentifier,
    scopeId: args.scopeId,
    resourceType,
    resourceId: args.resourceId,
    ancestors,
  });
  if (!evaluation.allowed) {
    return deny(
      evaluation.reasonCode,
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
  }

  if (!resolvedPermission) {
    return deny(
      "permission_missing",
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
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
    return deny(
      "invalid_request",
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
  }

  const request = {
    resourceType: resolvedPermission.resourceType,
    action: resolvedPermission.action,
    classification: resolvedPermission.classification,
    objectId: args.resourceId,
  };
  const decision = evaluateAccess({
    wildcard: evaluation.wildcard,
    entries: evaluation.entries,
    request,
  });

  if (decision === "allow") {
    return allow(
      evaluation.sourceVersion ?? 0,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
  }

  return deny(
    "permission_denied",
    evaluation.sourceVersion,
    evaluation.principalId,
    evaluation.effectiveRoleIds,
    hasExplicitDeny(evaluation.entries, request),
  );
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

function parseTokenIdentifier(tokenIdentifier: string) {
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    return null;
  }
  return {
    issuer: tokenIdentifier.slice(0, separatorIndex),
    subject: tokenIdentifier.slice(separatorIndex + 1),
  };
}

function allow(sourceVersion: number, principalId: string | undefined, effectiveRoleIds: string[]) {
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
) {
  return {
    allowed: false as const,
    reasonCode,
    explicitDeny,
    sourceVersion,
    principalId,
    effectiveRoleIds: effectiveRoleIds ?? [],
  };
}
