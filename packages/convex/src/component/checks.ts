import { queryGeneric, type DataModelFromSchemaDefinition, type QueryBuilder } from "convex/server";
import { v } from "convex/values";
import { evaluateAccess, type AccessRequest } from "./access";
import type schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// Public WITHIN the component boundary: a component's public functions are the
// parent-facing API. These checks are exactly what the app calls.
const query = queryGeneric as QueryBuilder<DataModel, "public">;

const resourceValidator = v.object({ type: v.string(), externalId: v.string() });

const checkInputValidator = v.object({
  tenantId: v.optional(v.string()),
  permission: v.string(),
  resource: v.optional(resourceValidator),
});

function toRequest(
  tokenIdentifier: string | undefined,
  input: { tenantId?: string; permission: string; resource?: { type: string; externalId: string } },
): AccessRequest {
  return {
    ...(tokenIdentifier === undefined ? {} : { tokenIdentifier }),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    permissionKey: input.permission,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
  };
}

// Single permission check. `tenantId` omitted resolves to the primary tenant.
export const check = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    permission: v.string(),
    resource: v.optional(resourceValidator),
  },
  handler: async (ctx, args) =>
    evaluateAccess(
      ctx,
      toRequest(args.tokenIdentifier, {
        ...(args.tenantId === undefined ? {} : { tenantId: args.tenantId }),
        permission: args.permission,
        ...(args.resource === undefined ? {} : { resource: args.resource }),
      }),
    ),
});

// Batched checks, sharing one identity. Used to access-scope a page of app rows.
export const checkMany = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    checks: v.array(checkInputValidator),
  },
  handler: async (ctx, args) => {
    if (args.checks.length > 100) {
      throw new Error("checkMany accepts at most 100 checks");
    }
    return await Promise.all(
      args.checks.map((input) => evaluateAccess(ctx, toRequest(args.tokenIdentifier, input))),
    );
  },
});
