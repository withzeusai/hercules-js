import { queryGeneric, type DataModelFromSchemaDefinition, type QueryBuilder } from "convex/server";
import { v } from "convex/values";
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

    const evaluation = await evaluateEffectiveAccess(ctx, args);
    if (!evaluation.allowed) {
      return deny(
        evaluation.reasonCode,
        evaluation.sourceVersion,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      );
    }

    if (!evaluation.catalogPermissionKeys.has(args.permission)) {
      return deny(
        "permission_missing",
        evaluation.sourceVersion,
        evaluation.principalId,
        evaluation.effectiveRoleIds,
      );
    }

    if (evaluation.permissions.some((permission) => permission.key === args.permission)) {
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
  },
});

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
