import {
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { evaluateAccess, MANAGE_ACTION, WILDCARD_ACTION } from "./authz";
import { evaluateEffectiveAccess } from "./effective";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

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
  },
) {
  const evaluation = await evaluateEffectiveAccess(ctx, args);
  if (!evaluation.allowed) {
    return deny(
      evaluation.reasonCode,
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
  }

  // Resolve the requested permission's canonical (resourceType, action) by
  // catalog lookup rather than parsing the key string. The producer ships
  // the structured columns verbatim, so this works for canonical
  // (app.appointments:create), dot-action (reports.export), and namespaced
  // keys alike without the runtime having to agree on slug grammar.
  // Catalog permissions always live in the default scope (DL15).
  const resolvedPermission = await findCatalogPermissionByKey(ctx, args.permission);
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
  if (
    resolvedPermission.action === MANAGE_ACTION ||
    resolvedPermission.action === WILDCARD_ACTION
  ) {
    return deny(
      "invalid_request",
      evaluation.sourceVersion,
      evaluation.principalId,
      evaluation.effectiveRoleIds,
    );
  }

  const decision = evaluateAccess({
    wildcard: evaluation.wildcard,
    entries: evaluation.entries,
    request: {
      resourceType: resolvedPermission.resourceType,
      action: resolvedPermission.action,
      objectId: args.resourceId,
    },
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
) {
  return {
    allowed: false as const,
    reasonCode,
    sourceVersion,
    principalId,
    effectiveRoleIds: effectiveRoleIds ?? [],
  };
}
