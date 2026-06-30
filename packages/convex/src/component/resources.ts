import {
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { evaluateAccess, resolveTenantRow } from "./access";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
type ResourceRow = DataModel["resources"]["document"];

const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const PAGE_LIMIT = 100;
function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return PAGE_LIMIT;
  return Math.min(limit, PAGE_LIMIT);
}

export type ResourceNode = {
  type: string;
  externalId: string;
  parent?: { type: string; externalId: string };
  data?: unknown;
};

export type ResourceNodesPage = { resources: ResourceNode[]; cursor?: string };

const parentValidator = v.object({ type: v.string(), externalId: v.string() });

function toNode(row: ResourceRow): ResourceNode {
  return {
    type: row.resourceType,
    externalId: row.externalId,
    ...(row.parentResourceType !== undefined && row.parentExternalId !== undefined
      ? { parent: { type: row.parentResourceType, externalId: row.parentExternalId } }
      : {}),
    ...(row.data === undefined ? {} : { data: row.data }),
  };
}

// Resolve the access tenant for a write, defaulting to the primary tenant.
async function resolveWriteTenantId(
  ctx: MutationCtx,
  tenantId: string | undefined,
): Promise<string | null> {
  if (tenantId !== undefined) {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_tenant_id", (q) => q.eq("tenantId", tenantId))
      .unique();
    return tenant?.tenantId ?? tenantId;
  }
  const primary = await ctx.db
    .query("tenants")
    .withIndex("by_primary", (q) => q.eq("isPrimaryTenant", true))
    .first();
  return primary?.tenantId ?? null;
}

// resource.list — the access-scoped resource listing. When `permission` is
// provided, each node is filtered through the same allow-only check used by
// iam.can, so the page contains only resources the caller may access. This
// replaces the old filterAuthorizedResources helper.
export const list = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    type: v.optional(v.string()),
    parent: v.optional(parentValidator),
    permission: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ResourceNodesPage> => {
    const tenant = await resolveTenantRow(ctx, args.tenantId);
    if (!tenant) return { resources: [] };
    const tenantId = tenant.tenantId;
    const limit = pageLimit(args.limit);

    const page = args.parent
      ? await paginator(ctx.db, schema)
          .query("resources")
          .withIndex("by_parent", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("parentResourceType", args.parent!.type)
              .eq("parentExternalId", args.parent!.externalId),
          )
          .paginate({ cursor: args.cursor ?? null, numItems: limit })
      : args.type !== undefined
        ? await paginator(ctx.db, schema)
            .query("resources")
            .withIndex("by_resource", (q) =>
              q.eq("tenantId", tenantId).eq("resourceType", args.type!),
            )
            .paginate({ cursor: args.cursor ?? null, numItems: limit })
        : await paginator(ctx.db, schema)
            .query("resources")
            .withIndex("by_resource", (q) => q.eq("tenantId", tenantId))
            .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let rows = page.page;
    if (args.parent && args.type !== undefined) {
      rows = rows.filter((row) => row.resourceType === args.type);
    }

    if (args.permission !== undefined) {
      const permission = args.permission;
      const allowed = await Promise.all(
        rows.map(async (row) => {
          const decision = await evaluateAccess(ctx, {
            ...(args.tokenIdentifier === undefined
              ? {}
              : { tokenIdentifier: args.tokenIdentifier }),
            tenantId,
            permissionKey: permission,
            resource: { type: row.resourceType, externalId: row.externalId },
          });
          return decision.allowed;
        }),
      );
      rows = rows.filter((_row, index) => allowed[index]);
    }

    return {
      resources: rows.map(toNode),
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

export const get = query({
  args: {
    tokenIdentifier: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    type: v.string(),
    externalId: v.string(),
    permission: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResourceNode | null> => {
    const tenant = await resolveTenantRow(ctx, args.tenantId);
    if (!tenant) return null;
    const tenantId = tenant.tenantId;
    if (args.permission !== undefined) {
      const decision = await evaluateAccess(ctx, {
        ...(args.tokenIdentifier === undefined ? {} : { tokenIdentifier: args.tokenIdentifier }),
        tenantId,
        permissionKey: args.permission,
        resource: { type: args.type, externalId: args.externalId },
      });
      if (!decision.allowed) return null;
    }
    const row = await resolveResourceRow(ctx, tenantId, args.type, args.externalId);
    return row ? toNode(row) : null;
  },
});

async function resolveResourceRow(
  ctx: QueryCtx,
  tenantId: string,
  type: string,
  externalId: string,
): Promise<ResourceRow | null> {
  return await ctx.db
    .query("resources")
    .withIndex("by_resource", (q) =>
      q.eq("tenantId", tenantId).eq("resourceType", type).eq("externalId", externalId),
    )
    .unique();
}

// resource.write — upsert a resource NODE into the component graph. The app owns
// resource lifecycle; this is a trusted write (no permission gate).
export const write = mutation({
  args: {
    tenantId: v.optional(v.string()),
    type: v.string(),
    externalId: v.string(),
    parent: v.optional(parentValidator),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ResourceNode | null> => {
    const tenantId = await resolveWriteTenantId(ctx, args.tenantId);
    if (!tenantId) return null;
    const row = {
      tenantId,
      resourceType: args.type,
      externalId: args.externalId,
      ...(args.parent === undefined
        ? {}
        : { parentResourceType: args.parent.type, parentExternalId: args.parent.externalId }),
      ...(args.data === undefined ? {} : { data: args.data }),
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("resources")
      .withIndex("by_resource", (q) =>
        q.eq("tenantId", tenantId).eq("resourceType", args.type).eq("externalId", args.externalId),
      )
      .unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("resources", row);
    return toNode(row as ResourceRow);
  },
});

// resource.delete — remove a single resource NODE. Children are left to the app
// to manage (the app owns resource lifecycle).
export const remove = mutation({
  args: {
    tenantId: v.optional(v.string()),
    type: v.string(),
    externalId: v.string(),
  },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const tenantId = await resolveWriteTenantId(ctx, args.tenantId);
    if (!tenantId) return { deleted: false };
    const existing = await ctx.db
      .query("resources")
      .withIndex("by_resource", (q) =>
        q.eq("tenantId", tenantId).eq("resourceType", args.type).eq("externalId", args.externalId),
      )
      .unique();
    if (!existing) return { deleted: false };
    await ctx.db.delete(existing._id);
    return { deleted: true };
  },
});
