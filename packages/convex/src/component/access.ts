import type { DataModelFromSchemaDefinition, GenericQueryCtx } from "convex/server";
import { parseTokenIdentifier } from "../shared/token";
import type schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;

type TenantRow = DataModel["tenants"]["document"];
type MembershipRow = DataModel["tenant_memberships"]["document"];
type ResourceNodeRow = DataModel["resources"]["document"];
type ResourceAssignmentRow =
  | DataModel["user_resource_role_assignments"]["document"]
  | DataModel["group_resource_role_assignments"]["document"];

// Hard cap on resource-hierarchy depth: a resource-scoped check walks the
// resource and at most this many ancestors. Generous for real nesting while
// bounding the per-call work.
const MAX_RESOURCE_DEPTH = 20;

export type AccessDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  membershipId?: string;
};

export type AccessRequest = {
  tokenIdentifier?: string;
  tenantId?: string;
  permissionKey: string;
  // `type` is a resource-type KEY (the app/SDK addresses resource types by key);
  // the engine resolves it to a resourceTypeId via resource_types.by_key.
  resource?: { type: string; externalId: string };
};

function allow(sourceVersion: number, membershipId: string | undefined): AccessDecision {
  return {
    allowed: true,
    reasonCode: "allowed",
    sourceVersion,
    ...(membershipId === undefined ? {} : { membershipId }),
  };
}

function deny(reasonCode: string, sourceVersion?: number, membershipId?: string): AccessDecision {
  return {
    allowed: false,
    reasonCode,
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(membershipId === undefined ? {} : { membershipId }),
  };
}

// Resolve the access tenant: an explicit tenant id, or the deployment's primary
// tenant when omitted. Never exposes the primary tenant id plumbing to callers.
export async function resolvePrimaryTenant(ctx: QueryCtx): Promise<TenantRow | null> {
  return await ctx.db
    .query("tenants")
    .withIndex("by_primary", (q) => q.eq("isPrimaryTenant", true))
    .first();
}

export async function resolveTenantRow(
  ctx: QueryCtx,
  tenantId: string | undefined,
): Promise<TenantRow | null> {
  if (tenantId === undefined) {
    return await resolvePrimaryTenant(ctx);
  }
  return await ctx.db
    .query("tenants")
    .withIndex("by_tenant_id", (q) => q.eq("id", tenantId))
    .unique();
}

async function resolveMembership(
  ctx: QueryCtx,
  tenantId: string,
  subject: string,
): Promise<MembershipRow | null> {
  // token.subject IS the OIDC subject = tenant_memberships.userId.
  return await ctx.db
    .query("tenant_memberships")
    .withIndex("by_tenant_user", (q) => q.eq("tenantId", tenantId).eq("userId", subject))
    .unique();
}

function membershipDenyReason(status: MembershipRow["status"]): string {
  switch (status) {
    case "pending_approval":
      return "membership_pending_approval";
    case "blocked":
      return "membership_blocked";
    case "suspended":
      return "membership_suspended";
    case "removed":
      return "membership_removed";
    case "active":
      return "allowed";
  }
}

// Collect the role ids a membership effectively holds tenant-wide: direct user
// assignments plus assignments to any active group the membership belongs to.
// Expired assignments are ignored.
export async function collectMembershipRoleIds(
  ctx: QueryCtx,
  membership: MembershipRow,
  now: number,
): Promise<Set<string>> {
  const roleIds = new Set<string>();

  const directAssignments = await ctx.db
    .query("user_role_assignments")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership.id))
    .collect();
  for (const assignment of directAssignments) {
    if (assignment.tenantId !== membership.tenantId) continue;
    if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) continue;
    roleIds.add(assignment.roleId);
  }

  const groupMemberships = await ctx.db
    .query("group_memberships")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership.id))
    .collect();
  for (const groupMembership of groupMemberships) {
    if (groupMembership.tenantId !== membership.tenantId) continue;
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("id", groupMembership.groupId))
      .unique();
    if (!group || group.status !== "active") continue;
    const groupAssignments = await ctx.db
      .query("group_role_assignments")
      .withIndex("by_group", (q) => q.eq("groupId", group.id))
      .collect();
    for (const assignment of groupAssignments) {
      if (assignment.tenantId !== membership.tenantId) continue;
      if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) continue;
      roleIds.add(assignment.roleId);
    }
  }

  return roleIds;
}

// The subset of a membership's tenant-wide role ids that are APP-SCOPED
// (roles.isAppScope). App-scoped roles held via the caller's PRIMARY-tenant
// membership confer app-wide authority, so they are unioned into every tenant's
// decision.
export async function collectAppScopedRoleIds(
  ctx: QueryCtx,
  membership: MembershipRow,
  now: number,
): Promise<Set<string>> {
  const appScoped = new Set<string>();
  for (const roleId of await collectMembershipRoleIds(ctx, membership, now)) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_role_id", (q) => q.eq("id", roleId))
      .unique();
    if (role && role.isAppScope) appScoped.add(roleId);
  }
  return appScoped;
}

async function roleHasPermission(
  ctx: QueryCtx,
  roleId: string,
  permissionId: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("role_permissions")
    .withIndex("by_role_permission", (q) => q.eq("roleId", roleId).eq("permissionId", permissionId))
    .unique();
  return row !== null;
}

async function anyRoleHasPermission(
  ctx: QueryCtx,
  roleIds: Iterable<string>,
  permissionId: string,
): Promise<boolean> {
  for (const roleId of roleIds) {
    if (await roleHasPermission(ctx, roleId, permissionId)) return true;
  }
  return false;
}

// Join key segments with a separator, escaping the separator and escape
// character in each segment so distinct tuples can never collide. Shared by the
// resource-chain match keys here and the deterministic resource-node id in
// resources.ts.
export function composeKey(...segments: string[]): string {
  // Length-prefix framing (`<len>:<segment>` per part) makes the join
  // injective without any separator escaping. Never a raw NUL byte: this
  // string is persisted as the resource-node id / parentId and is used as a
  // Convex index key.
  return segments.map((segment) => `${segment.length}:${segment}`).join("");
}

// The match key an assignment must sit on to authorize a node: a (resourceTypeId,
// externalId) pair. Both the chain and the assignments live in resourceTypeId
// space, so matching is id-to-id with no key resolution.
function resourceKey(resourceTypeId: string, externalId: string): string {
  return composeKey(resourceTypeId, externalId);
}

async function resolveResourceTypeIdByKey(ctx: QueryCtx, key: string): Promise<string | null> {
  const row = await ctx.db
    .query("resource_types")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row?.id ?? null;
}

async function resolveResourceNode(
  ctx: QueryCtx,
  tenantId: string,
  resourceTypeId: string,
  externalId: string,
): Promise<ResourceNodeRow | null> {
  return await ctx.db
    .query("resources")
    .withIndex("by_resource", (q) =>
      q.eq("tenantId", tenantId).eq("resourceTypeId", resourceTypeId).eq("externalId", externalId),
    )
    .unique();
}

// Build the set of (resourceTypeId, externalId) match keys that an assignment
// may sit on to authorize the target: the target node itself plus every
// ancestor reached by walking parentId node edges in the `resources` graph.
//
// An ancestor is only honored once its node is confirmed to still exist in the
// same tenant. `resource.delete` intentionally leaves a child's parentId edge
// dangling (no child cascade), so a stale resource-role assignment on a DELETED
// ancestor must NOT keep authorizing the child: we stop the walk at the first
// missing (or cross-tenant) parent.
async function buildResourceChain(
  ctx: QueryCtx,
  tenantId: string,
  resource: { type: string; externalId: string },
): Promise<Set<string>> {
  const chain = new Set<string>();
  const typeId = await resolveResourceTypeIdByKey(ctx, resource.type);
  // Unknown resource type: no resource-scoped grant is possible.
  if (typeId === null) return chain;
  // The target is always authorizable directly: a resource-role assignment on
  // the target grants regardless of whether a node row exists for it.
  chain.add(resourceKey(typeId, resource.externalId));

  let current = await resolveResourceNode(ctx, tenantId, typeId, resource.externalId);
  const visited = new Set<string>();
  if (current) visited.add(current.id);
  let depth = 0;
  while (current && current.parentId !== undefined && depth < MAX_RESOURCE_DEPTH) {
    const parentId: string = current.parentId;
    const parent = await ctx.db
      .query("resources")
      .withIndex("by_resource_id", (q) => q.eq("id", parentId))
      .unique();
    if (!parent) break; // dangling parent edge (the parent node was deleted)
    if (parent.tenantId !== tenantId) break; // cross-tenant edge is ignored
    if (visited.has(parent.id)) break; // cycle guard
    visited.add(parent.id);
    chain.add(resourceKey(parent.resourceTypeId, parent.externalId));
    current = parent;
    depth += 1;
  }
  return chain;
}

// The canonical access check. Allow-only union of tenant-wide and resource-scoped
// role authority, plus app-wide authority from APP-SCOPED roles held via the
// caller's PRIMARY-tenant membership. Reads only the local mirror.
export async function evaluateAccess(
  ctx: QueryCtx,
  request: AccessRequest,
): Promise<AccessDecision> {
  if (!request.tokenIdentifier) return deny("missing_identity");
  const token = parseTokenIdentifier(request.tokenIdentifier);
  if (!token) return deny("invalid_identity");

  const state = await ctx.db.query("sync_state").unique();
  if (!state) return deny("mirror_not_ready");
  const sourceVersion = state.sourceVersion;
  if (token.issuer !== state.expectedIssuer) return deny("unexpected_issuer", sourceVersion);

  const tenant = await resolveTenantRow(ctx, request.tenantId);
  if (!tenant) return deny("tenant_missing", sourceVersion);
  // A disabled (archived) tenant blocks all access, even for an otherwise-valid
  // membership or an app-scoped role held via the primary tenant.
  if (tenant.status !== "active") return deny("tenant_archived", sourceVersion);

  // Resolve the permission's canonical row up front: an unknown permission can
  // never be granted, regardless of membership.
  const permission = await ctx.db
    .query("permissions")
    .withIndex("by_key", (q) => q.eq("key", request.permissionKey))
    .unique();
  if (!permission) return deny("permission_missing", sourceVersion);

  // The caller's membership in the TARGET tenant and (when different) the
  // PRIMARY tenant. App-scoped authority rides on the primary membership.
  const primary = await resolvePrimaryTenant(ctx);
  const membershipT = await resolveMembership(ctx, tenant.id, token.subject);
  const membershipP =
    primary && primary.id !== tenant.id
      ? await resolveMembership(ctx, primary.id, token.subject)
      : membershipT;

  const now = Date.now();

  // Tenant-wide role ids: the target membership's own roles, unioned with the
  // caller's app-scoped roles held via an ACTIVE primary membership. The
  // app-scope union is gated only on the primary membership being active and is
  // skipped when the target tenant IS the primary (no double-counting).
  const roleIds = new Set<string>();
  if (membershipT && membershipT.status === "active") {
    for (const roleId of await collectMembershipRoleIds(ctx, membershipT, now)) roleIds.add(roleId);
  }
  if (primary && primary.id !== tenant.id && membershipP && membershipP.status === "active") {
    for (const roleId of await collectAppScopedRoleIds(ctx, membershipP, now)) roleIds.add(roleId);
  }

  if (await anyRoleHasPermission(ctx, roleIds, permission.id)) {
    return allow(sourceVersion, membershipT?.id ?? membershipP?.id);
  }

  // Resource-scoped roles on the target or any ancestor. These require an active
  // membership in the TARGET tenant (resource assignments are tenant-local).
  if (request.resource && membershipT && membershipT.status === "active") {
    const chain = await buildResourceChain(ctx, tenant.id, request.resource);
    const groupIds = await collectMembershipGroupIds(ctx, membershipT);
    const assignments = await collectResourceAssignments(ctx, membershipT, groupIds);
    for (const assignment of assignments) {
      if (assignment.tenantId !== tenant.id) continue;
      if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) continue;
      if (!chain.has(resourceKey(assignment.resourceTypeId, assignment.externalId))) continue;
      if (await roleHasPermission(ctx, assignment.roleId, permission.id)) {
        return allow(sourceVersion, membershipT.id);
      }
    }
  }

  // Implicit deny, reported against the target-tenant membership state.
  if (!membershipT) return deny("membership_missing", sourceVersion, membershipP?.id);
  if (membershipT.status !== "active") {
    return deny(membershipDenyReason(membershipT.status), sourceVersion, membershipT.id);
  }
  return deny("permission_denied", sourceVersion, membershipT.id);
}

async function collectMembershipGroupIds(
  ctx: QueryCtx,
  membership: MembershipRow,
): Promise<string[]> {
  const groupMemberships = await ctx.db
    .query("group_memberships")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership.id))
    .collect();
  const groupIds: string[] = [];
  for (const groupMembership of groupMemberships) {
    if (groupMembership.tenantId !== membership.tenantId) continue;
    const group = await ctx.db
      .query("groups")
      .withIndex("by_group_id", (q) => q.eq("id", groupMembership.groupId))
      .unique();
    if (group && group.status === "active") groupIds.push(group.id);
  }
  return groupIds;
}

async function collectResourceAssignments(
  ctx: QueryCtx,
  membership: MembershipRow,
  groupIds: string[],
): Promise<ResourceAssignmentRow[]> {
  const direct = await ctx.db
    .query("user_resource_role_assignments")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership.id))
    .collect();
  const fromGroups = (
    await Promise.all(
      groupIds.map((groupId) =>
        ctx.db
          .query("group_resource_role_assignments")
          .withIndex("by_group", (q) => q.eq("groupId", groupId))
          .collect(),
      ),
    )
  ).flat();
  return [...direct, ...fromGroups];
}
