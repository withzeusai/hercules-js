import {
  internalMutationGeneric,
  makeFunctionReference,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import {
  accessProjectionSyncPayloadSchema,
  type AccessProjectionChange,
  type AccessProjectionEntities,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
  type ScopeMetadata,
} from "../shared/sync";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const internalMutation = internalMutationGeneric as MutationBuilder<
  DataModel,
  "internal"
>;
const expireGrantReference = makeFunctionReference<
  "mutation",
  { grantId: string; expiresAt: number; updatedAt: number }
>("component/sync:expireGrant");

type User = AccessProjectionEntities["users"][number];
type Principal = AccessProjectionEntities["principals"][number];
type PrincipalMembership =
  AccessProjectionEntities["principalMemberships"][number];
type Role = AccessProjectionEntities["roles"][number];
type Permission = AccessProjectionEntities["permissions"][number];
type RolePermission = AccessProjectionEntities["rolePermissions"][number];
type Grant = AccessProjectionEntities["grants"][number];
type StoredPrincipal = Principal & { accessScopeId: string };
type StoredPrincipalMembership = PrincipalMembership & {
  accessScopeId: string;
};
type StoredGrant = Grant & { objectScopeId: string };

type Projection = {
  scopes: Map<string, ScopeMetadata>;
  users: Map<string, User>;
  principals: Map<string, StoredPrincipal>;
  principalMemberships: Map<string, StoredPrincipalMembership>;
  roles: Map<string, Role>;
  permissions: Map<string, Permission>;
  rolePermissions: Map<string, RolePermission>;
  grants: Map<string, StoredGrant>;
};

const syncPayloadArgs = {
  type: v.union(
    v.literal("access.projection.snapshot"),
    v.literal("access.projection.event"),
  ),
  schemaVersion: v.literal(3),
  eventId: v.string(),
  sourceVersion: v.number(),
  mode: v.optional(v.union(v.literal("initialize"), v.literal("reset"))),
  expectedIssuer: v.optional(v.string()),
  scopes: v.array(v.any()),
};

export const applySync = internalMutation({
  args: syncPayloadArgs,
  handler: async (ctx, rawArgs) => {
    if (
      rawArgs.type === "access.projection.snapshot" &&
      !rawArgs.scopes.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          "scope" in entry &&
          entry.scope !== null &&
          typeof entry.scope === "object" &&
          "kind" in entry.scope &&
          entry.scope.kind === "default",
      )
    ) {
      return { ok: false as const, status: "default_scope_required" as const };
    }

    const parsed = accessProjectionSyncPayloadSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    const payload = parsed.data;
    const state = await ctx.db.query("sync_state").unique();

    if (state?.lastEventId === payload.eventId) {
      if (state.sourceVersion !== payload.sourceVersion) {
        return { ok: false as const, status: "invalid_payload" as const };
      }
      return {
        ok: true as const,
        status: "duplicate" as const,
        acknowledgedVersion: state.sourceVersion,
      };
    }

    if (payload.type === "access.projection.event") {
      if (!state) {
        return {
          ok: false as const,
          status: "not_ready" as const,
          currentVersion: 0,
        };
      }

      const expectedVersion = state.sourceVersion + 1;
      if (payload.sourceVersion !== expectedVersion) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion,
          receivedVersion: payload.sourceVersion,
        };
      }
    } else {
      if (payload.mode === "initialize" && state) {
        return {
          ok: false as const,
          status: "reset_required" as const,
          currentVersion: state.sourceVersion,
        };
      }
      if (payload.mode === "reset" && !state) {
        return {
          ok: false as const,
          status: "not_ready" as const,
          currentVersion: 0,
        };
      }
      if (state && state.expectedIssuer !== payload.expectedIssuer) {
        return { ok: false as const, status: "issuer_mismatch" as const };
      }
      if (
        payload.mode === "reset" &&
        state &&
        payload.sourceVersion < state.sourceVersion
      ) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion: state.sourceVersion + 1,
          receivedVersion: payload.sourceVersion,
        };
      }
    }

    const projection =
      payload.type === "access.projection.snapshot"
        ? projectionFromSnapshot(payload)
        : await projectionFromDatabase();

    if (!projection) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    if (
      payload.type === "access.projection.event" &&
      !applyEventToProjection(projection, payload)
    ) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    const now = Date.now();
    removeExpiredGrants(projection, now);

    if (!validateProjection(projection)) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    if (payload.type === "access.projection.snapshot") {
      await replaceProjection(projection);
    } else {
      await applyEvent(payload, now);
    }

    const nextState = {
      sourceVersion: payload.sourceVersion,
      expectedIssuer:
        payload.type === "access.projection.snapshot"
          ? payload.expectedIssuer
          : state!.expectedIssuer,
      lastEventId: payload.eventId,
      lastSyncedAt: Date.now(),
    };
    if (state) {
      await ctx.db.replace(state._id, nextState);
    } else {
      await ctx.db.insert("sync_state", nextState);
    }

    return {
      ok: true as const,
      status: "applied" as const,
      acknowledgedVersion: payload.sourceVersion,
    };

    async function projectionFromDatabase(): Promise<Projection> {
      const [
        scopes,
        users,
        principals,
        principalMemberships,
        roles,
        permissions,
        rolePermissions,
        grants,
      ] = await Promise.all([
        ctx.db.query("scopes").collect(),
        ctx.db.query("users").collect(),
        ctx.db.query("principals").collect(),
        ctx.db.query("principal_memberships").collect(),
        ctx.db.query("roles").collect(),
        ctx.db.query("permissions").collect(),
        ctx.db.query("role_permissions").collect(),
        ctx.db.query("grants").collect(),
      ]);

      return {
        scopes: new Map(
          scopes.map((row) => [row.accessScopeId, stripSystemFields(row)]),
        ),
        users: new Map(
          users.map((row) => [row.herculesAuthUserId, stripSystemFields(row)]),
        ),
        principals: new Map(
          principals.map((row) => [row.principalId, stripSystemFields(row)]),
        ),
        principalMemberships: new Map(
          principalMemberships.map((row) => [
            membershipKey(
              row.accessScopeId,
              row.groupPrincipalId,
              row.memberPrincipalId,
            ),
            stripSystemFields(row),
          ]),
        ),
        roles: new Map(
          roles.map((row) => [row.roleId, stripSystemFields(row)]),
        ),
        permissions: new Map(
          permissions.map((row) => [row.permissionId, stripSystemFields(row)]),
        ),
        rolePermissions: new Map(
          rolePermissions.map((row) => [
            rolePermissionKey(
              row.accessScopeId,
              row.roleId,
              row.permissionId,
              row.effect,
            ),
            stripSystemFields(row),
          ]),
        ),
        grants: new Map(
          grants.map((row) => [row.grantId, stripSystemFields(row)]),
        ),
      };
    }

    async function replaceProjection(projectionToWrite: Projection) {
      await clearTable("grants");
      await clearTable("role_permissions");
      await clearTable("permissions");
      await clearTable("roles");
      await clearTable("principal_memberships");
      await clearTable("principals");
      await clearTable("organizations");
      await clearTable("scopes");
      await clearTable("users");

      for (const scope of projectionToWrite.scopes.values())
        await insertScope(scope);
      for (const user of projectionToWrite.users.values())
        await ctx.db.insert("users", user);
      for (const principal of projectionToWrite.principals.values()) {
        await ctx.db.insert("principals", principal);
      }
      for (const membership of projectionToWrite.principalMemberships.values()) {
        await ctx.db.insert("principal_memberships", membership);
      }
      for (const role of projectionToWrite.roles.values())
        await ctx.db.insert("roles", role);
      for (const permission of projectionToWrite.permissions.values()) {
        await ctx.db.insert("permissions", permission);
      }
      for (const rolePermission of projectionToWrite.rolePermissions.values()) {
        await ctx.db.insert("role_permissions", rolePermission);
      }
      for (const grant of projectionToWrite.grants.values()) {
        await ctx.db.insert("grants", grant);
        await scheduleGrantExpiration(grant);
      }
    }

    async function applyEvent(event: AccessProjectionEvent, now: number) {
      const deferredUserCleanupIds = new Set<string>();

      for (const scopeEvent of event.scopes) {
        await upsertScope(scopeEvent.scope);
        for (const user of scopeEvent.entities.users) await upsertUser(user);
      }

      for (const scopeEvent of event.scopes) {
        const accessScopeId = scopeEvent.scope.accessScopeId;
        for (const change of scopeEvent.changes) {
          if (change.operation === "delete") {
            await deleteEntity(change, accessScopeId, deferredUserCleanupIds);
            continue;
          }

          switch (change.entityType) {
            case "principal":
              await upsertPrincipal(
                accessScopeId,
                findPrincipal(scopeEvent.entities, change.entityId)!,
                deferredUserCleanupIds,
              );
              break;
            case "principal_membership": {
              const [groupPrincipalId, memberPrincipalId] = splitCompositeId(
                change.entityId,
                2,
              )!;
              await upsertPrincipalMembership(
                accessScopeId,
                scopeEvent.entities.principalMemberships.find(
                  (candidate) =>
                    candidate.groupPrincipalId === groupPrincipalId &&
                    candidate.memberPrincipalId === memberPrincipalId,
                )!,
              );
              break;
            }
            case "role":
              await upsertRole(findRole(scopeEvent.entities, change.entityId)!);
              break;
            case "permission":
              await upsertPermission(
                findPermission(scopeEvent.entities, change.entityId)!,
              );
              break;
            case "role_permission": {
              const [roleId, permissionId, effect] = splitCompositeId(
                change.entityId,
                3,
              )!;
              await upsertRolePermission(
                scopeEvent.entities.rolePermissions.find(
                  (candidate) =>
                    candidate.roleId === roleId &&
                    candidate.permissionId === permissionId &&
                    candidate.effect === effect,
                )!,
              );
              break;
            }
            case "grant":
              await upsertGrant(
                accessScopeId,
                findGrant(scopeEvent.entities, change.entityId)!,
                now,
              );
              break;
          }
        }
      }

      for (const herculesAuthUserId of deferredUserCleanupIds) {
        await deleteUserIfUnreferenced(herculesAuthUserId);
      }
    }

    async function clearTable(
      table:
        | "users"
        | "scopes"
        | "organizations"
        | "principals"
        | "principal_memberships"
        | "roles"
        | "permissions"
        | "role_permissions"
        | "grants",
    ) {
      for (const row of await ctx.db.query(table).collect())
        await ctx.db.delete(row._id);
    }

    async function insertScope(scope: ScopeMetadata) {
      await ctx.db.insert("scopes", scope);
      if (scope.kind === "org") {
        await ctx.db.insert("organizations", organizationFromScope(scope));
      }
    }

    async function upsertScope(scope: ScopeMetadata) {
      const existing = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (query) =>
          query.eq("accessScopeId", scope.accessScopeId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, scope);
      else await ctx.db.insert("scopes", scope);

      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (query) =>
          query.eq("accessScopeId", scope.accessScopeId),
        )
        .unique();
      if (scope.kind !== "org") {
        if (organization) await ctx.db.delete(organization._id);
        return;
      }

      const organizationRow = organizationFromScope(scope);
      if (organization) await ctx.db.replace(organization._id, organizationRow);
      else await ctx.db.insert("organizations", organizationRow);
    }

    async function upsertUser(user: User) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (query) =>
          query.eq("herculesAuthUserId", user.herculesAuthUserId),
        )
        .unique();
      if (existing && existing.updatedAt >= user.updatedAt) return;
      if (existing) await ctx.db.replace(existing._id, user);
      else await ctx.db.insert("users", user);
    }

    async function upsertPrincipal(
      accessScopeId: string,
      principal: Principal,
      deferredUserCleanupIds: Set<string>,
    ) {
      const existing = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (query) =>
          query.eq("principalId", principal.principalId),
        )
        .unique();
      const row = { accessScopeId, ...principal };
      if (existing) {
        await ctx.db.replace(existing._id, row);
        if (
          existing.herculesAuthUserId &&
          existing.herculesAuthUserId !== principal.herculesAuthUserId
        ) {
          deferredUserCleanupIds.add(existing.herculesAuthUserId);
        }
      } else {
        await ctx.db.insert("principals", row);
      }
    }

    async function upsertPrincipalMembership(
      accessScopeId: string,
      membership: PrincipalMembership,
    ) {
      const existing = await ctx.db
        .query("principal_memberships")
        .withIndex("by_group_member", (query) =>
          query
            .eq("accessScopeId", accessScopeId)
            .eq("groupPrincipalId", membership.groupPrincipalId)
            .eq("memberPrincipalId", membership.memberPrincipalId),
        )
        .unique();
      const row = { accessScopeId, ...membership };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("principal_memberships", row);
    }

    async function upsertRole(role: Role) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (query) => query.eq("roleId", role.roleId))
        .unique();
      if (existing) await ctx.db.replace(existing._id, role);
      else await ctx.db.insert("roles", role);
    }

    async function upsertPermission(permission: Permission) {
      const existing = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (query) =>
          query.eq("permissionId", permission.permissionId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, permission);
      else await ctx.db.insert("permissions", permission);
    }

    async function upsertRolePermission(rolePermission: RolePermission) {
      const existing = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission_effect", (query) =>
          query
            .eq("accessScopeId", rolePermission.accessScopeId)
            .eq("roleId", rolePermission.roleId)
            .eq("permissionId", rolePermission.permissionId)
            .eq("effect", rolePermission.effect),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, rolePermission);
      else await ctx.db.insert("role_permissions", rolePermission);
    }

    async function upsertGrant(
      objectScopeId: string,
      grant: Grant,
      now: number,
    ) {
      const existing = await ctx.db
        .query("grants")
        .withIndex("by_grant_id", (query) => query.eq("grantId", grant.grantId))
        .unique();
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
        if (existing) await ctx.db.delete(existing._id);
        return;
      }
      const row = { objectScopeId, ...grant };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("grants", row);
      await scheduleGrantExpiration(row);
    }

    async function scheduleGrantExpiration(grant: StoredGrant) {
      if (grant.expiresAt === undefined) return;
      await ctx.scheduler.runAt(grant.expiresAt, expireGrantReference, {
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        updatedAt: grant.updatedAt,
      });
    }

    async function deleteEntity(
      change: AccessProjectionChange,
      accessScopeId: string,
      deferredUserCleanupIds: Set<string>,
    ) {
      switch (change.entityType) {
        case "principal": {
          const principal = await ctx.db
            .query("principals")
            .withIndex("by_principal_id", (query) =>
              query.eq("principalId", change.entityId),
            )
            .unique();
          if (!principal) return;
          for (const grant of await ctx.db
            .query("grants")
            .withIndex("by_subject_principal_object", (query) =>
              query.eq("subjectPrincipalId", change.entityId),
            )
            .collect()) {
            await ctx.db.delete(grant._id);
          }
          for (const membership of await ctx.db
            .query("principal_memberships")
            .withIndex("by_group", (query) =>
              query
                .eq("accessScopeId", accessScopeId)
                .eq("groupPrincipalId", change.entityId),
            )
            .collect()) {
            await ctx.db.delete(membership._id);
          }
          for (const membership of await ctx.db
            .query("principal_memberships")
            .withIndex("by_member", (query) =>
              query
                .eq("accessScopeId", accessScopeId)
                .eq("memberPrincipalId", change.entityId),
            )
            .collect()) {
            await ctx.db.delete(membership._id);
          }
          await ctx.db.delete(principal._id);
          if (principal.herculesAuthUserId) {
            deferredUserCleanupIds.add(principal.herculesAuthUserId);
          }
          return;
        }
        case "principal_membership": {
          const parts = splitCompositeId(change.entityId, 2);
          if (!parts) return;
          const groupPrincipalId = parts[0]!;
          const memberPrincipalId = parts[1]!;
          const membership = await ctx.db
            .query("principal_memberships")
            .withIndex("by_group_member", (query) =>
              query
                .eq("accessScopeId", accessScopeId)
                .eq("groupPrincipalId", groupPrincipalId)
                .eq("memberPrincipalId", memberPrincipalId),
            )
            .unique();
          if (membership) await ctx.db.delete(membership._id);
          return;
        }
        case "role": {
          const role = await ctx.db
            .query("roles")
            .withIndex("by_role_id", (query) =>
              query.eq("roleId", change.entityId),
            )
            .unique();
          if (!role) return;
          for (const row of await ctx.db.query("role_permissions").collect()) {
            if (row.roleId === change.entityId) await ctx.db.delete(row._id);
          }
          for (const grant of await ctx.db.query("grants").collect()) {
            if (
              grant.roleId === change.entityId ||
              grant.subjectRoleId === change.entityId
            ) {
              await ctx.db.delete(grant._id);
            }
          }
          await ctx.db.delete(role._id);
          return;
        }
        case "permission": {
          const permission = await ctx.db
            .query("permissions")
            .withIndex("by_permission_id", (query) =>
              query.eq("permissionId", change.entityId),
            )
            .unique();
          if (!permission) return;
          for (const row of await ctx.db.query("role_permissions").collect()) {
            if (row.permissionId === change.entityId)
              await ctx.db.delete(row._id);
          }
          for (const grant of await ctx.db
            .query("grants")
            .withIndex("by_permission", (query) =>
              query.eq("permissionId", change.entityId),
            )
            .collect()) {
            await ctx.db.delete(grant._id);
          }
          await ctx.db.delete(permission._id);
          return;
        }
        case "role_permission": {
          const parts = splitCompositeId(change.entityId, 3);
          if (!parts) return;
          const roleId = parts[0]!;
          const permissionId = parts[1]!;
          const effect = parts[2]!;
          if (effect !== "allow" && effect !== "deny") return;
          const rolePermission = await ctx.db
            .query("role_permissions")
            .withIndex("by_role_permission_effect", (query) =>
              query
                .eq("accessScopeId", accessScopeId)
                .eq("roleId", roleId)
                .eq("permissionId", permissionId)
                .eq("effect", effect),
            )
            .unique();
          if (rolePermission) await ctx.db.delete(rolePermission._id);
          return;
        }
        case "grant": {
          const grant = await ctx.db
            .query("grants")
            .withIndex("by_grant_id", (query) =>
              query.eq("grantId", change.entityId),
            )
            .unique();
          if (grant) await ctx.db.delete(grant._id);
        }
      }
    }

    async function deleteUserIfUnreferenced(herculesAuthUserId: string) {
      const remainingPrincipal = await ctx.db
        .query("principals")
        .withIndex("by_auth_user", (query) =>
          query.eq("herculesAuthUserId", herculesAuthUserId),
        )
        .first();
      if (remainingPrincipal) return;
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (query) =>
          query.eq("herculesAuthUserId", herculesAuthUserId),
        )
        .unique();
      if (user) await ctx.db.delete(user._id);
    }
  },
});

export const expireGrant = internalMutation({
  args: {
    grantId: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("grants")
      .withIndex("by_grant_id", (query) => query.eq("grantId", args.grantId))
      .unique();
    if (
      !grant ||
      grant.expiresAt !== args.expiresAt ||
      grant.updatedAt !== args.updatedAt
    ) {
      return;
    }
    if (args.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(
        args.expiresAt,
        expireGrantReference,
        args,
      );
      return;
    }
    await ctx.db.delete(grant._id);
  },
});

function projectionFromSnapshot(
  snapshot: AccessProjectionSnapshot,
): Projection | null {
  const projection = emptyProjection();

  for (const scopeSnapshot of snapshot.scopes) {
    const scopeId = scopeSnapshot.scope.accessScopeId;
    if (projection.scopes.has(scopeId)) return null;
    projection.scopes.set(scopeId, scopeSnapshot.scope);

    for (const user of scopeSnapshot.entities.users) {
      const existing = projection.users.get(user.herculesAuthUserId);
      if (!existing || existing.updatedAt < user.updatedAt) {
        projection.users.set(user.herculesAuthUserId, user);
      }
    }
    for (const principal of scopeSnapshot.entities.principals) {
      if (projection.principals.has(principal.principalId)) return null;
      projection.principals.set(principal.principalId, {
        accessScopeId: scopeId,
        ...principal,
      });
    }
    for (const membership of scopeSnapshot.entities.principalMemberships) {
      const key = membershipKey(
        scopeId,
        membership.groupPrincipalId,
        membership.memberPrincipalId,
      );
      if (projection.principalMemberships.has(key)) return null;
      projection.principalMemberships.set(key, {
        accessScopeId: scopeId,
        ...membership,
      });
    }
    for (const role of scopeSnapshot.entities.roles) {
      if (role.accessScopeId !== scopeId) return null;
      if (projection.roles.has(role.roleId)) return null;
      projection.roles.set(role.roleId, role);
    }
    for (const permission of scopeSnapshot.entities.permissions) {
      if (permission.accessScopeId !== scopeId) return null;
      if (projection.permissions.has(permission.permissionId)) return null;
      projection.permissions.set(permission.permissionId, permission);
    }
    for (const rolePermission of scopeSnapshot.entities.rolePermissions) {
      if (rolePermission.accessScopeId !== scopeId) return null;
      const key = rolePermissionKey(
        rolePermission.accessScopeId,
        rolePermission.roleId,
        rolePermission.permissionId,
        rolePermission.effect,
      );
      if (projection.rolePermissions.has(key)) return null;
      projection.rolePermissions.set(key, rolePermission);
    }
    for (const grant of scopeSnapshot.entities.grants) {
      if (projection.grants.has(grant.grantId)) return null;
      projection.grants.set(grant.grantId, {
        objectScopeId: scopeId,
        ...grant,
      });
    }
  }

  return projection;
}

function applyEventToProjection(
  projection: Projection,
  event: AccessProjectionEvent,
): boolean {
  const scopeIds = new Set<string>();

  for (const scopeEvent of event.scopes) {
    const scopeId = scopeEvent.scope.accessScopeId;
    if (scopeIds.has(scopeId) || !validateEventEntityLists(scopeEvent.entities))
      return false;
    scopeIds.add(scopeId);
    projection.scopes.set(scopeId, scopeEvent.scope);

    for (const user of scopeEvent.entities.users) {
      const existing = projection.users.get(user.herculesAuthUserId);
      if (!existing || existing.updatedAt < user.updatedAt) {
        projection.users.set(user.herculesAuthUserId, user);
      }
    }

    for (const change of scopeEvent.changes) {
      if (
        change.operation === "upsert" &&
        !applyProjectionUpsert(projection, scopeId, change, scopeEvent.entities)
      ) {
        return false;
      }
      if (change.operation === "delete") {
        if (!applyProjectionDelete(projection, scopeId, change)) return false;
      }
    }
  }

  return true;
}

function removeExpiredGrants(projection: Projection, now: number) {
  for (const [grantId, grant] of projection.grants) {
    if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
      projection.grants.delete(grantId);
    }
  }
}

function applyProjectionUpsert(
  projection: Projection,
  scopeId: string,
  change: AccessProjectionChange,
  entities: AccessProjectionEntities,
): boolean {
  switch (change.entityType) {
    case "principal": {
      const principal = findPrincipal(entities, change.entityId);
      if (!principal) return false;
      const existing = projection.principals.get(principal.principalId);
      if (existing && existing.accessScopeId !== scopeId) return false;
      projection.principals.set(principal.principalId, {
        accessScopeId: scopeId,
        ...principal,
      });
      return true;
    }
    case "principal_membership": {
      const parts = splitCompositeId(change.entityId, 2);
      if (!parts) return false;
      const groupPrincipalId = parts[0]!;
      const memberPrincipalId = parts[1]!;
      const membership = entities.principalMemberships.find(
        (candidate) =>
          candidate.groupPrincipalId === groupPrincipalId &&
          candidate.memberPrincipalId === memberPrincipalId,
      );
      if (!membership) return false;
      projection.principalMemberships.set(
        membershipKey(scopeId, groupPrincipalId, memberPrincipalId),
        { accessScopeId: scopeId, ...membership },
      );
      return true;
    }
    case "role": {
      const role = findRole(entities, change.entityId);
      if (!role || role.accessScopeId !== scopeId) return false;
      const existing = projection.roles.get(role.roleId);
      if (existing && existing.accessScopeId !== role.accessScopeId)
        return false;
      projection.roles.set(role.roleId, role);
      return true;
    }
    case "permission": {
      const permission = findPermission(entities, change.entityId);
      if (!permission || permission.accessScopeId !== scopeId) return false;
      const existing = projection.permissions.get(permission.permissionId);
      if (existing && existing.accessScopeId !== permission.accessScopeId)
        return false;
      projection.permissions.set(permission.permissionId, permission);
      return true;
    }
    case "role_permission": {
      const parts = splitCompositeId(change.entityId, 3);
      if (!parts) return false;
      const [roleId, permissionId, effect] = parts;
      if (effect !== "allow" && effect !== "deny") return false;
      const rolePermission = entities.rolePermissions.find(
        (candidate) =>
          candidate.roleId === roleId &&
          candidate.permissionId === permissionId &&
          candidate.effect === effect,
      );
      if (!rolePermission || rolePermission.accessScopeId !== scopeId)
        return false;
      projection.rolePermissions.set(
        rolePermissionKey(
          rolePermission.accessScopeId,
          rolePermission.roleId,
          rolePermission.permissionId,
          rolePermission.effect,
        ),
        rolePermission,
      );
      return true;
    }
    case "grant": {
      const grant = findGrant(entities, change.entityId);
      if (!grant) return false;
      const existing = projection.grants.get(grant.grantId);
      if (existing && existing.objectScopeId !== scopeId) return false;
      projection.grants.set(grant.grantId, {
        objectScopeId: scopeId,
        ...grant,
      });
      return true;
    }
  }
}

function applyProjectionDelete(
  projection: Projection,
  scopeId: string,
  change: AccessProjectionChange,
): boolean {
  switch (change.entityType) {
    case "principal": {
      const principal = projection.principals.get(change.entityId);
      if (principal && principal.accessScopeId !== scopeId) return false;
      projection.principals.delete(change.entityId);
      for (const [key, membership] of projection.principalMemberships) {
        if (
          membership.groupPrincipalId === change.entityId ||
          membership.memberPrincipalId === change.entityId
        ) {
          projection.principalMemberships.delete(key);
        }
      }
      for (const [grantId, grant] of projection.grants) {
        if (grant.subjectPrincipalId === change.entityId)
          projection.grants.delete(grantId);
      }
      return true;
    }
    case "principal_membership": {
      const parts = splitCompositeId(change.entityId, 2);
      if (parts) {
        projection.principalMemberships.delete(
          membershipKey(scopeId, parts[0]!, parts[1]!),
        );
      }
      return true;
    }
    case "role": {
      const role = projection.roles.get(change.entityId);
      if (role && role.accessScopeId !== scopeId) return false;
      projection.roles.delete(change.entityId);
      for (const [key, rolePermission] of projection.rolePermissions) {
        if (rolePermission.roleId === change.entityId)
          projection.rolePermissions.delete(key);
      }
      for (const [grantId, grant] of projection.grants) {
        if (
          grant.roleId === change.entityId ||
          grant.subjectRoleId === change.entityId
        ) {
          projection.grants.delete(grantId);
        }
      }
      return true;
    }
    case "permission": {
      const permission = projection.permissions.get(change.entityId);
      if (permission && permission.accessScopeId !== scopeId) return false;
      projection.permissions.delete(change.entityId);
      for (const [key, rolePermission] of projection.rolePermissions) {
        if (rolePermission.permissionId === change.entityId) {
          projection.rolePermissions.delete(key);
        }
      }
      for (const [grantId, grant] of projection.grants) {
        if (grant.permissionId === change.entityId)
          projection.grants.delete(grantId);
      }
      return true;
    }
    case "role_permission": {
      const parts = splitCompositeId(change.entityId, 3);
      if (parts && (parts[2] === "allow" || parts[2] === "deny")) {
        projection.rolePermissions.delete(
          rolePermissionKey(scopeId, parts[0]!, parts[1]!, parts[2]),
        );
      }
      return true;
    }
    case "grant": {
      const grant = projection.grants.get(change.entityId);
      if (grant && grant.objectScopeId !== scopeId) return false;
      projection.grants.delete(change.entityId);
      return true;
    }
  }
}

function validateProjection(projection: Projection): boolean {
  const defaultScopes = [...projection.scopes.values()].filter(
    (scope) => scope.kind === "default",
  );
  if (defaultScopes.length !== 1) return false;
  const defaultScopeId = defaultScopes[0]!.accessScopeId;

  for (const principal of projection.principals.values()) {
    if (!projection.scopes.has(principal.accessScopeId)) return false;
    if (principal.type === "user" && !principal.herculesAuthUserId)
      return false;
    if (principal.type === "group" && principal.herculesAuthUserId)
      return false;
  }

  for (const membership of projection.principalMemberships.values()) {
    const group = projection.principals.get(membership.groupPrincipalId);
    const member = projection.principals.get(membership.memberPrincipalId);
    if (
      !group ||
      !member ||
      group.type !== "group" ||
      group.accessScopeId !== membership.accessScopeId ||
      member.accessScopeId !== membership.accessScopeId
    ) {
      return false;
    }
  }

  for (const role of projection.roles.values()) {
    if (!projection.scopes.has(role.accessScopeId)) return false;
    if (role.kind === "custom" && role.wildcard !== "none") return false;
    if (
      role.kind === "custom" &&
      (role.key === "owner" || role.key === "admin")
    )
      return false;
    if (role.kind === "system" && role.accessScopeId !== defaultScopeId)
      return false;
    if (
      role.key === "owner" &&
      (role.kind !== "system" || role.wildcard !== "immutable")
    ) {
      return false;
    }
    if (
      role.key === "admin" &&
      (role.kind !== "system" ||
        (role.wildcard !== "default" && role.wildcard !== "none"))
    ) {
      return false;
    }
    if (
      role.wildcard === "immutable" &&
      (role.kind !== "system" || role.key !== "owner")
    ) {
      return false;
    }
    if (
      role.wildcard === "default" &&
      (role.kind !== "system" || role.key !== "admin")
    ) {
      return false;
    }
  }

  for (const permission of projection.permissions.values()) {
    if (permission.accessScopeId !== defaultScopeId) return false;
  }

  for (const rolePermission of projection.rolePermissions.values()) {
    const role = projection.roles.get(rolePermission.roleId);
    if (
      !projection.scopes.has(rolePermission.accessScopeId) ||
      !role ||
      !projection.permissions.has(rolePermission.permissionId) ||
      (role.accessScopeId !== defaultScopeId &&
        role.accessScopeId !== rolePermission.accessScopeId)
    ) {
      return false;
    }
  }

  for (const grant of projection.grants.values()) {
    if (!projection.scopes.has(grant.objectScopeId)) return false;
    if (grant.subjectPrincipalId) {
      const principal = projection.principals.get(grant.subjectPrincipalId);
      if (!principal || principal.accessScopeId !== grant.objectScopeId)
        return false;
    }
    if (
      grant.subjectScopeId !== undefined &&
      grant.subjectScopeId !== grant.objectScopeId
    ) {
      return false;
    }
    if (grant.subjectRoleId) {
      const subjectRole = projection.roles.get(grant.subjectRoleId);
      if (
        !subjectRole ||
        !roleCanApplyToScope(subjectRole, grant.objectScopeId, defaultScopeId)
      ) {
        return false;
      }
    }

    if (grant.relationKind === "role") {
      const role = grant.roleId
        ? projection.roles.get(grant.roleId)
        : undefined;
      if (
        !role ||
        !roleCanApplyToScope(role, grant.objectScopeId, defaultScopeId)
      ) {
        return false;
      }
      if (
        grant.objectType === "resource" &&
        (role.kind === "system" ||
          role.key === "owner" ||
          role.key === "admin" ||
          role.wildcard !== "none")
      ) {
        return false;
      }
    } else {
      const permission = grant.permissionId
        ? projection.permissions.get(grant.permissionId)
        : undefined;
      if (!permission) return false;
      if (
        grant.objectType === "resource" &&
        permission.resourceType !== grant.objectResourceType
      ) {
        return false;
      }
    }
  }

  return true;
}

function validateEventEntityLists(entities: AccessProjectionEntities): boolean {
  return (
    hasUniqueValues(entities.users, (user) => user.herculesAuthUserId) &&
    hasUniqueValues(
      entities.principals,
      (principal) => principal.principalId,
    ) &&
    hasUniqueValues(
      entities.principalMemberships,
      (membership) =>
        `${membership.groupPrincipalId}:${membership.memberPrincipalId}`,
    ) &&
    hasUniqueValues(entities.roles, (role) => role.roleId) &&
    hasUniqueValues(
      entities.permissions,
      (permission) => permission.permissionId,
    ) &&
    hasUniqueValues(
      entities.rolePermissions,
      (row) => `${row.roleId}:${row.permissionId}:${row.effect}`,
    ) &&
    hasUniqueValues(entities.grants, (grant) => grant.grantId)
  );
}

function roleCanApplyToScope(
  role: Role,
  scopeId: string,
  defaultScopeId: string,
): boolean {
  return (
    role.accessScopeId === scopeId ||
    (role.kind === "system" && role.accessScopeId === defaultScopeId)
  );
}

function emptyProjection(): Projection {
  return {
    scopes: new Map(),
    users: new Map(),
    principals: new Map(),
    principalMemberships: new Map(),
    roles: new Map(),
    permissions: new Map(),
    rolePermissions: new Map(),
    grants: new Map(),
  };
}

function findPrincipal(
  entities: AccessProjectionEntities,
  principalId: string,
) {
  return entities.principals.find(
    (candidate) => candidate.principalId === principalId,
  );
}

function findRole(entities: AccessProjectionEntities, roleId: string) {
  return entities.roles.find((candidate) => candidate.roleId === roleId);
}

function findPermission(
  entities: AccessProjectionEntities,
  permissionId: string,
) {
  return entities.permissions.find(
    (candidate) => candidate.permissionId === permissionId,
  );
}

function findGrant(entities: AccessProjectionEntities, grantId: string) {
  return entities.grants.find((candidate) => candidate.grantId === grantId);
}

function membershipKey(
  scopeId: string,
  groupPrincipalId: string,
  memberPrincipalId: string,
) {
  return `${scopeId}:${groupPrincipalId}:${memberPrincipalId}`;
}

function rolePermissionKey(
  scopeId: string,
  roleId: string,
  permissionId: string,
  effect: "allow" | "deny",
) {
  return `${scopeId}:${roleId}:${permissionId}:${effect}`;
}

function splitCompositeId(entityId: string, length: number): string[] | null {
  const parts = entityId.split(":");
  return parts.length === length && parts.every(Boolean) ? parts : null;
}

function organizationFromScope(scope: ScopeMetadata) {
  return {
    accessScopeId: scope.accessScopeId,
    name: scope.name,
    status: scope.status,
    accountEntryMode: scope.accountEntryMode,
    updatedAt: scope.updatedAt,
  };
}

function hasUniqueValues<T>(values: T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

function stripSystemFields<T extends { _id: unknown; _creationTime: number }>(
  row: T,
): Omit<T, "_id" | "_creationTime"> {
  const { _id: _id, _creationTime: _creationTime, ...value } = row;
  return value;
}
