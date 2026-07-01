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
import { composeKey, evaluateAccess, resolveTenantRow } from "./access";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
type ResourceRow = DataModel["resources"]["document"];
type ResourceTypeRow = DataModel["resource_types"]["document"];

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
};

export type ResourceNodesPage = { resources: ResourceNode[]; cursor?: string };

const parentValidator = v.object({ type: v.string(), externalId: v.string() });

// resource_types are addressed by KEY on the wire but stored/linked by id in the
// node graph. These two resolvers bridge the two spaces; the id→key resolver is
// cache-backed so a page of nodes resolves each type once.
async function resolveResourceTypeByKey(
  ctx: QueryCtx,
  key: string,
): Promise<ResourceTypeRow | null> {
  return await ctx.db
    .query("resource_types")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function resourceTypeKey(
  ctx: QueryCtx,
  resourceTypeId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(resourceTypeId);
  if (cached !== undefined) return cached;
  const row = await ctx.db
    .query("resource_types")
    .withIndex("by_resource_type_id", (q) => q.eq("id", resourceTypeId))
    .unique();
  const key = row?.key ?? null;
  cache.set(resourceTypeId, key);
  return key;
}

// Reconstruct the app-facing node shape from stored ids: map resourceTypeId back
// to its key, and (when parentId is set) resolve the parent node to expose its
// type key + externalId. Returns null when the node's own type key cannot be
// resolved (an orphaned resourceTypeId).
async function toNode(
  ctx: QueryCtx,
  row: ResourceRow,
  cache: Map<string, string | null>,
): Promise<ResourceNode | null> {
  const typeKey = await resourceTypeKey(ctx, row.resourceTypeId, cache);
  if (typeKey === null) return null;
  let parent: { type: string; externalId: string } | undefined;
  if (row.parentId !== undefined) {
    const parentId: string = row.parentId;
    const parentRow = await ctx.db
      .query("resources")
      .withIndex("by_resource_id", (q) => q.eq("id", parentId))
      .unique();
    if (parentRow) {
      const parentKey = await resourceTypeKey(ctx, parentRow.resourceTypeId, cache);
      if (parentKey !== null) parent = { type: parentKey, externalId: parentRow.externalId };
    }
  }
  return { type: typeKey, externalId: row.externalId, ...(parent === undefined ? {} : { parent }) };
}

// The deterministic node id: a stable escaped composite of the tuple that
// uniquely names a node within a deployment. Because it is derived (not minted),
// upserts key on the same id and children reference their parent by the same
// composite without a node lookup.
function resourceNodeId(tenantId: string, resourceTypeId: string, externalId: string): string {
  return composeKey(tenantId, resourceTypeId, externalId);
}

// Resolve the access tenant for a write, defaulting to the primary tenant.
async function resolveWriteTenantId(
  ctx: MutationCtx,
  tenantId: string | undefined,
): Promise<string | null> {
  if (tenantId !== undefined) {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_tenant_id", (q) => q.eq("id", tenantId))
      .unique();
    return tenant?.id ?? tenantId;
  }
  const primary = await ctx.db
    .query("tenants")
    .withIndex("by_primary", (q) => q.eq("isPrimaryTenant", true))
    .first();
  return primary?.id ?? null;
}

async function resolveResourceRow(
  ctx: QueryCtx,
  tenantId: string,
  resourceTypeId: string,
  externalId: string,
): Promise<ResourceRow | null> {
  return await ctx.db
    .query("resources")
    .withIndex("by_resource", (q) =>
      q.eq("tenantId", tenantId).eq("resourceTypeId", resourceTypeId).eq("externalId", externalId),
    )
    .unique();
}

// resource.list — the access-scoped resource listing. When `permission` is
// provided, each node is filtered through the same allow-only check used by
// access.can, so the page contains only resources the caller may access.
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
    const tenantId = tenant.id;
    const limit = pageLimit(args.limit);

    // Resolve the optional `type` filter to a resourceTypeId. An unknown type
    // matches nothing.
    const childTypeId =
      args.type === undefined
        ? undefined
        : ((await resolveResourceTypeByKey(ctx, args.type))?.id ?? null);
    if (childTypeId === null) return { resources: [] };

    // Resolve the optional `parent` filter to its deterministic node id.
    const parent = args.parent;
    const parentNodeId =
      parent === undefined
        ? undefined
        : await (async (): Promise<string | null> => {
            const parentType = await resolveResourceTypeByKey(ctx, parent.type);
            return parentType ? resourceNodeId(tenantId, parentType.id, parent.externalId) : null;
          })();
    if (parentNodeId === null) return { resources: [] };

    const page =
      parentNodeId !== undefined
        ? await paginator(ctx.db, schema)
            .query("resources")
            .withIndex("by_parent", (q) => q.eq("parentId", parentNodeId))
            .paginate({ cursor: args.cursor ?? null, numItems: limit })
        : childTypeId !== undefined
          ? await paginator(ctx.db, schema)
              .query("resources")
              .withIndex("by_resource", (q) =>
                q.eq("tenantId", tenantId).eq("resourceTypeId", childTypeId),
              )
              .paginate({ cursor: args.cursor ?? null, numItems: limit })
          : await paginator(ctx.db, schema)
              .query("resources")
              .withIndex("by_resource", (q) => q.eq("tenantId", tenantId))
              .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let rows = page.page;
    if (parentNodeId !== undefined && childTypeId !== undefined) {
      rows = rows.filter((row) => row.resourceTypeId === childTypeId);
    }

    const cache = new Map<string, string | null>();
    if (args.permission !== undefined) {
      const permission = args.permission;
      const allowed = await Promise.all(
        rows.map(async (row) => {
          const typeKey = await resourceTypeKey(ctx, row.resourceTypeId, cache);
          if (typeKey === null) return false;
          const decision = await evaluateAccess(ctx, {
            ...(args.tokenIdentifier === undefined
              ? {}
              : { tokenIdentifier: args.tokenIdentifier }),
            tenantId,
            permissionKey: permission,
            resource: { type: typeKey, externalId: row.externalId },
          });
          return decision.allowed;
        }),
      );
      rows = rows.filter((_row, index) => allowed[index]);
    }

    const resources = (await Promise.all(rows.map((row) => toNode(ctx, row, cache)))).filter(
      (node): node is ResourceNode => node !== null,
    );
    return { resources, ...(page.isDone ? {} : { cursor: page.continueCursor }) };
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
    const tenantId = tenant.id;
    if (args.permission !== undefined) {
      const decision = await evaluateAccess(ctx, {
        ...(args.tokenIdentifier === undefined ? {} : { tokenIdentifier: args.tokenIdentifier }),
        tenantId,
        permissionKey: args.permission,
        resource: { type: args.type, externalId: args.externalId },
      });
      if (!decision.allowed) return null;
    }
    const childType = await resolveResourceTypeByKey(ctx, args.type);
    if (!childType) return null;
    const row = await resolveResourceRow(ctx, tenantId, childType.id, args.externalId);
    if (!row) return null;
    return toNode(ctx, row, new Map<string, string | null>());
  },
});

// resource.write — upsert a resource NODE into the component graph. The app owns
// resource lifecycle; this is a trusted write (no permission gate). The parent
// edge is stored as the parent's deterministic node id, computed from the
// child's declared parentResourceTypeId and the supplied parent externalId
// (order-independent: a not-yet-written parent just leaves a dangling edge).
export const write = mutation({
  args: {
    tenantId: v.optional(v.string()),
    type: v.string(),
    externalId: v.string(),
    parent: v.optional(parentValidator),
  },
  handler: async (ctx, args): Promise<ResourceNode | null> => {
    const tenantId = await resolveWriteTenantId(ctx, args.tenantId);
    if (!tenantId) return null;
    const childType = await resolveResourceTypeByKey(ctx, args.type);
    if (!childType) return null; // unknown resource type

    let parentId: string | undefined;
    if (args.parent !== undefined && childType.parentResourceTypeId !== null) {
      // The supplied parent `type` must resolve to the child's declared parent
      // type; a mismatch is ignored (no parent edge stored).
      const parentType = await resolveResourceTypeByKey(ctx, args.parent.type);
      if (parentType && parentType.id === childType.parentResourceTypeId) {
        parentId = resourceNodeId(tenantId, childType.parentResourceTypeId, args.parent.externalId);
      }
    }

    const id = resourceNodeId(tenantId, childType.id, args.externalId);
    const row = {
      id,
      tenantId,
      resourceTypeId: childType.id,
      externalId: args.externalId,
      updatedAt: Date.now(),
      ...(parentId === undefined ? {} : { parentId }),
    };
    const existing = await resolveResourceRow(ctx, tenantId, childType.id, args.externalId);
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("resources", row);
    return toNode(ctx, row as ResourceRow, new Map<string, string | null>());
  },
});

// resource.delete — remove a single resource NODE. Children are left with a
// dangling parentId; the access check stops the ancestor walk at the missing
// node, so no cascade is required here.
export const remove = mutation({
  args: {
    tenantId: v.optional(v.string()),
    type: v.string(),
    externalId: v.string(),
  },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const tenantId = await resolveWriteTenantId(ctx, args.tenantId);
    if (!tenantId) return { deleted: false };
    const childType = await resolveResourceTypeByKey(ctx, args.type);
    if (!childType) return { deleted: false };
    const existing = await resolveResourceRow(ctx, tenantId, childType.id, args.externalId);
    if (!existing) return { deleted: false };
    await ctx.db.delete(existing._id);
    return { deleted: true };
  },
});
