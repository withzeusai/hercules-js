import {
  internalMutationGeneric,
  makeFunctionReference,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import {
  accessProjectionSyncPayloadSchema,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
  type ProjectionCatalogDelta,
  type ProjectionScopeDelta,
  type ProjectionScopeMetadata,
  type ProjectionUserDelta,
} from "../shared/sync";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;

// Exact-identity expiry mutations: scheduled at expiresAt so the reactive query
// is invalidated when a time-bound binding lapses. The runtime readers also
// fail closed on the timestamp, so a delayed schedule never over-grants.
const expireRoleBindingReference = makeFunctionReference<
  "mutation",
  { bindingId: string; expiresAt: number; updatedAt: number }
>("component/sync:expireRoleBinding");
const expirePermissionBindingReference = makeFunctionReference<
  "mutation",
  { bindingId: string; expiresAt: number; updatedAt: number }
>("component/sync:expirePermissionBinding");

// Convex transactions have document-count limits. Reject an oversized aggregate
// with a clear payload failure rather than letting the mutation abort opaquely.
const MAX_SNAPSHOT_DOCUMENTS = 16_000;

// The args validator is intentionally loose (the producer ships either payload
// kind); real validation is the zod parse below. Accept the v3 top-level shape.
const syncPayloadArgs = {
  type: v.union(v.literal("access.projection.snapshot"), v.literal("access.projection.event")),
  schemaVersion: v.number(),
  eventId: v.string(),
  sourceVersion: v.number(),
  mode: v.optional(v.union(v.literal("initialize"), v.literal("reset"))),
  expectedIssuer: v.optional(v.string()),
  catalog: v.optional(v.any()),
  users: v.optional(v.any()),
  scopes: v.optional(v.array(v.any())),
};

export const applySync = internalMutation({
  args: syncPayloadArgs,
  handler: async (ctx, rawArgs) => {
    if (rawArgs.schemaVersion !== 3) {
      return { ok: false as const, status: "unsupported_schema" as const };
    }

    // A bootstrap/reset aggregate must carry the default scope (the zod also
    // checks default-first/exactly-one, but this returns a precise status the
    // reconciler keys on before paying for a full parse).
    if (
      rawArgs.type === "access.projection.snapshot" &&
      !(rawArgs.scopes ?? []).some(
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

    // Idempotency: a re-delivered event/snapshot with the same eventId is a
    // no-op ack (the version must match what we recorded for that eventId).
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
        return { ok: false as const, status: "not_ready" as const, currentVersion: 0 };
      }
      // Contract point 1: events apply strictly at currentVersion + 1.
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
      // initialize requires a clean mirror; reset requires an existing one.
      if (payload.mode === "initialize" && state) {
        return {
          ok: false as const,
          status: "reset_required" as const,
          currentVersion: state.sourceVersion,
        };
      }
      if (payload.mode === "reset" && !state) {
        return { ok: false as const, status: "not_ready" as const, currentVersion: 0 };
      }
      if (state && state.expectedIssuer !== payload.expectedIssuer) {
        return { ok: false as const, status: "issuer_mismatch" as const };
      }
      if (payload.mode === "reset" && state && payload.sourceVersion < state.sourceVersion) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion: state.sourceVersion + 1,
          receivedVersion: payload.sourceVersion,
        };
      }
    }

    const now = Date.now();

    if (payload.type === "access.projection.snapshot") {
      if (snapshotDocumentCount(payload) > MAX_SNAPSHOT_DOCUMENTS) {
        return { ok: false as const, status: "invalid_payload" as const };
      }
      // Whole-aggregate atomic install. A Convex mutation is a single
      // transaction, so no scope becomes visible until the entire snapshot
      // commits (contract point 2).
      await replaceProjection(payload, now);
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

    // ── snapshot install ──────────────────────────────────────────────────
    async function replaceProjection(snapshot: AccessProjectionSnapshot, now: number) {
      // Clear children-before-parents is unnecessary (no DB FKs), so order only
      // for clarity. Every table is wiped before re-install.
      await clearTable("permission_bindings");
      await clearTable("role_bindings");
      await clearTable("role_permission_overrides");
      await clearTable("role_permissions");
      await clearTable("permissions");
      await clearTable("roles");
      await clearTable("principal_memberships");
      await clearTable("principals");
      await clearTable("organizations");
      await clearTable("scopes");
      await clearTable("users");

      // Deployment-wide catalog (NEVER per-scope). Catalog roles carry no
      // accessScopeId; permissions are pinned to the default scope id for
      // lookup symmetry.
      const defaultScopeId = snapshot.scopes[0]!.scope.accessScopeId;

      for (const role of snapshot.catalog.roles) {
        await ctx.db.insert("roles", {
          roleId: role.roleId,
          key: role.key,
          source: role.source,
          name: role.name,
          baseWildcard: role.baseWildcard,
          updatedAt: role.updatedAt,
        });
      }
      for (const permission of snapshot.catalog.permissions) {
        await ctx.db.insert("permissions", {
          accessScopeId: defaultScopeId,
          permissionId: permission.permissionId,
          key: permission.key,
          resourceType: permission.resourceType,
          action: permission.action,
          classification: permission.classification,
          tenantAssignable: permission.tenantAssignable,
          updatedAt: permission.updatedAt,
        });
      }
      for (const rolePermission of snapshot.catalog.rolePermissions) {
        await ctx.db.insert("role_permissions", {
          roleId: rolePermission.roleId,
          permissionId: rolePermission.permissionId,
          effect: rolePermission.effect,
          updatedAt: rolePermission.updatedAt,
        });
      }

      // Deployment-wide users.
      for (const user of snapshot.users) {
        await ctx.db.insert("users", { ...user });
      }

      // Per-scope runtime state.
      for (const scopeEntry of snapshot.scopes) {
        await insertScope(scopeEntry.scope);

        for (const principal of scopeEntry.principals) {
          await ctx.db.insert("principals", {
            accessScopeId: scopeEntry.scope.accessScopeId,
            ...principal,
          });
        }
        for (const membership of scopeEntry.principalMemberships) {
          await ctx.db.insert("principal_memberships", {
            accessScopeId: scopeEntry.scope.accessScopeId,
            ...membership,
          });
        }
        for (const role of scopeEntry.roles) {
          await ctx.db.insert("roles", {
            roleId: role.roleId,
            key: role.key,
            source: role.source,
            name: role.name,
            baseWildcard: role.baseWildcard,
            accessScopeId: role.accessScopeId,
            updatedAt: role.updatedAt,
          });
        }
        for (const override of scopeEntry.rolePermissionOverrides) {
          await ctx.db.insert("role_permission_overrides", { ...override });
        }
        for (const binding of scopeEntry.roleBindings) {
          if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
            continue;
          }
          await ctx.db.insert("role_bindings", { ...binding });
          await scheduleRoleBindingExpiration(binding);
        }
        for (const binding of scopeEntry.permissionBindings) {
          if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
            continue;
          }
          await ctx.db.insert("permission_bindings", { ...binding });
          await schedulePermissionBindingExpiration(binding);
        }
      }
    }

    // ── event application ─────────────────────────────────────────────────
    async function applyEvent(event: AccessProjectionEvent, now: number) {
      if (event.catalog) await applyCatalogDelta(event.catalog);
      if (event.users) await applyUserDelta(event.users);
      for (const scopeDelta of event.scopes ?? []) {
        await applyScopeDelta(scopeDelta, now);
      }
    }

    async function applyCatalogDelta(catalog: ProjectionCatalogDelta) {
      const defaultScopeId = await getDefaultScopeId();
      for (const change of catalog.changes) {
        if (change.operation === "delete") {
          switch (change.entityType) {
            case "role":
              await deleteCatalogRole(change.roleId);
              break;
            case "permission":
              await deletePermission(change.permissionId);
              break;
            case "role_permission":
              await deleteRolePermission(change.roleId, change.permissionId);
              break;
          }
          continue;
        }
        switch (change.entityType) {
          case "role": {
            const role = catalog.roles.find((r) => r.roleId === change.roleId)!;
            await upsertCatalogRole({
              roleId: role.roleId,
              key: role.key,
              source: role.source,
              name: role.name,
              baseWildcard: role.baseWildcard,
              updatedAt: role.updatedAt,
            });
            break;
          }
          case "permission": {
            const permission = catalog.permissions.find(
              (p) => p.permissionId === change.permissionId,
            )!;
            await upsertPermission({
              accessScopeId: defaultScopeId,
              permissionId: permission.permissionId,
              key: permission.key,
              resourceType: permission.resourceType,
              action: permission.action,
              classification: permission.classification,
              tenantAssignable: permission.tenantAssignable,
              updatedAt: permission.updatedAt,
            });
            break;
          }
          case "role_permission": {
            const rolePermission = catalog.rolePermissions.find(
              (rp) => rp.roleId === change.roleId && rp.permissionId === change.permissionId,
            )!;
            await upsertRolePermission({
              roleId: rolePermission.roleId,
              permissionId: rolePermission.permissionId,
              effect: rolePermission.effect,
              updatedAt: rolePermission.updatedAt,
            });
            break;
          }
        }
      }
    }

    async function applyUserDelta(delta: ProjectionUserDelta) {
      for (const change of delta.changes) {
        if (change.operation === "delete") {
          await deleteUser(change.herculesAuthUserId);
          continue;
        }
        const user = delta.users.find((u) => u.herculesAuthUserId === change.herculesAuthUserId)!;
        await upsertUser({ ...user });
      }
    }

    async function applyScopeDelta(scope: ProjectionScopeDelta, now: number) {
      const accessScopeId = scope.accessScopeId;
      if (scope.scope) await upsertScope(scope.scope);

      for (const change of scope.changes) {
        if (change.operation === "delete") {
          switch (change.entityType) {
            case "scope":
              await deleteScope(change.accessScopeId);
              break;
            case "principal":
              await deletePrincipal(accessScopeId, change.principalId);
              break;
            case "principal_membership":
              await deleteMembership(
                accessScopeId,
                change.groupPrincipalId,
                change.memberPrincipalId,
              );
              break;
            case "role":
              await deleteTenantRole(change.roleId);
              break;
            case "role_permission_override":
              await deleteOverride(change.accessScopeId, change.roleId, change.permissionId);
              break;
            case "role_binding":
              await deleteRoleBinding(change.bindingId);
              break;
            case "permission_binding":
              await deletePermissionBinding(change.bindingId);
              break;
          }
          continue;
        }

        switch (change.entityType) {
          // A `scope` upsert change is satisfied by `scope.scope` above; the
          // integrity rule guarantees the metadata row is present.
          case "scope":
            break;
          case "principal": {
            const principal = scope.principals.find((p) => p.principalId === change.principalId)!;
            await upsertPrincipal(accessScopeId, principal);
            break;
          }
          case "principal_membership": {
            const membership = scope.principalMemberships.find(
              (m) =>
                m.groupPrincipalId === change.groupPrincipalId &&
                m.memberPrincipalId === change.memberPrincipalId,
            )!;
            await upsertMembership(accessScopeId, membership);
            break;
          }
          case "role": {
            const role = scope.roles.find((r) => r.roleId === change.roleId)!;
            await upsertTenantRole({
              roleId: role.roleId,
              key: role.key,
              source: role.source,
              name: role.name,
              baseWildcard: role.baseWildcard,
              accessScopeId: role.accessScopeId,
              updatedAt: role.updatedAt,
            });
            break;
          }
          case "role_permission_override": {
            const override = scope.rolePermissionOverrides.find(
              (o) =>
                o.accessScopeId === change.accessScopeId &&
                o.roleId === change.roleId &&
                o.permissionId === change.permissionId,
            )!;
            await upsertOverride({ ...override });
            break;
          }
          case "role_binding": {
            const binding = scope.roleBindings.find((b) => b.bindingId === change.bindingId)!;
            await upsertRoleBinding({ ...binding }, now);
            break;
          }
          case "permission_binding": {
            const binding = scope.permissionBindings.find((b) => b.bindingId === change.bindingId)!;
            await upsertPermissionBinding({ ...binding }, now);
            break;
          }
        }
      }
    }

    // ── table helpers ─────────────────────────────────────────────────────
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
        | "role_permission_overrides"
        | "role_bindings"
        | "permission_bindings",
    ) {
      for (const row of await ctx.db.query(table).collect()) {
        await ctx.db.delete(row._id);
      }
    }

    async function getDefaultScopeId(): Promise<string> {
      const defaultScope = await ctx.db
        .query("scopes")
        .withIndex("by_kind", (q) => q.eq("kind", "default"))
        .unique();
      // The mirror always holds exactly one default scope (snapshot installs it
      // before any event applies). Fall back to empty string defensively.
      return defaultScope?.accessScopeId ?? "";
    }

    async function insertScope(scope: ProjectionScopeMetadata) {
      await ctx.db.insert("scopes", { ...scope });
      if (scope.kind === "org" || scope.kind === "suite") {
        await ctx.db.insert("organizations", organizationFromScope(scope));
      }
    }

    async function upsertScope(scope: ProjectionScopeMetadata) {
      const existing = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", scope.accessScopeId))
        .unique();
      if (existing) await ctx.db.replace(existing._id, { ...scope });
      else await ctx.db.insert("scopes", { ...scope });

      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", scope.accessScopeId))
        .unique();
      if (scope.kind !== "org" && scope.kind !== "suite") {
        if (organization) await ctx.db.delete(organization._id);
        return;
      }
      const row = organizationFromScope(scope);
      if (organization) await ctx.db.replace(organization._id, row);
      else await ctx.db.insert("organizations", row);
    }

    async function deleteScope(accessScopeId: string) {
      const scope = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", accessScopeId))
        .unique();
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", accessScopeId))
        .unique();
      if (organization) await ctx.db.delete(organization._id);
      if (scope) await ctx.db.delete(scope._id);
    }

    async function upsertUser(user: {
      herculesAuthUserId: string;
      name: string;
      email: string;
      emailVerified: boolean;
      image?: string;
      phone?: string;
      phoneVerified: boolean;
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", user.herculesAuthUserId))
        .unique();
      if (existing && existing.updatedAt >= user.updatedAt) return;
      if (existing) await ctx.db.replace(existing._id, user);
      else await ctx.db.insert("users", user);
    }

    async function deleteUser(herculesAuthUserId: string) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", herculesAuthUserId))
        .unique();
      if (user) await ctx.db.delete(user._id);
    }

    async function upsertPrincipal(
      accessScopeId: string,
      principal: {
        principalId: string;
        type: "user" | "group";
        herculesAuthUserId?: string;
        status: "active" | "blocked" | "suspended" | "pending_approval";
        joinedAt: number;
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", principal.principalId))
        .unique();
      const row = { accessScopeId, ...principal };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("principals", row);
    }

    async function deletePrincipal(accessScopeId: string, principalId: string) {
      const principal = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", principalId))
        .unique();
      if (!principal) return;

      // Cascade: the principal's bindings (as subject) and memberships.
      for (const binding of await ctx.db
        .query("role_bindings")
        .withIndex("by_subject_principal", (q) => q.eq("subjectPrincipalId", principalId))
        .collect()) {
        await ctx.db.delete(binding._id);
      }
      for (const binding of await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_principal", (q) => q.eq("subjectPrincipalId", principalId))
        .collect()) {
        await ctx.db.delete(binding._id);
      }
      for (const membership of await ctx.db
        .query("principal_memberships")
        .withIndex("by_group", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("groupPrincipalId", principalId),
        )
        .collect()) {
        await ctx.db.delete(membership._id);
      }
      for (const membership of await ctx.db
        .query("principal_memberships")
        .withIndex("by_member", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("memberPrincipalId", principalId),
        )
        .collect()) {
        await ctx.db.delete(membership._id);
      }
      await ctx.db.delete(principal._id);
    }

    async function upsertMembership(
      accessScopeId: string,
      membership: { groupPrincipalId: string; memberPrincipalId: string; updatedAt: number },
    ) {
      const existing = await ctx.db
        .query("principal_memberships")
        .withIndex("by_group_member", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("groupPrincipalId", membership.groupPrincipalId)
            .eq("memberPrincipalId", membership.memberPrincipalId),
        )
        .unique();
      const row = { accessScopeId, ...membership };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("principal_memberships", row);
    }

    async function deleteMembership(
      accessScopeId: string,
      groupPrincipalId: string,
      memberPrincipalId: string,
    ) {
      const membership = await ctx.db
        .query("principal_memberships")
        .withIndex("by_group_member", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("groupPrincipalId", groupPrincipalId)
            .eq("memberPrincipalId", memberPrincipalId),
        )
        .unique();
      if (membership) await ctx.db.delete(membership._id);
    }

    async function upsertCatalogRole(role: {
      roleId: string;
      key: string;
      source: "system" | "iam" | "tenant";
      name: string;
      baseWildcard: "none" | "immutable" | "default";
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", role.roleId))
        .unique();
      // Catalog roles carry NO accessScopeId.
      if (existing) await ctx.db.replace(existing._id, role);
      else await ctx.db.insert("roles", role);
    }

    async function upsertTenantRole(role: {
      roleId: string;
      key: string;
      source: "system" | "iam" | "tenant";
      name: string;
      baseWildcard: "none" | "immutable" | "default";
      accessScopeId: string;
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", role.roleId))
        .unique();
      if (existing) await ctx.db.replace(existing._id, role);
      else await ctx.db.insert("roles", role);
    }

    async function deleteRoleEverywhere(roleId: string) {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique();
      if (!role) return;

      // Cascade base mappings + per-scope overrides keyed on this role.
      for (const row of await ctx.db
        .query("role_permissions")
        .withIndex("by_role", (q) => q.eq("roleId", roleId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      for (const row of await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_role", (q) => q.eq("roleId", roleId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      // Cascade bindings: role bindings of this role, and permission bindings
      // with this role as subject.
      for (const binding of await ctx.db
        .query("role_bindings")
        .withIndex("by_role", (q) => q.eq("roleId", roleId))
        .collect()) {
        await ctx.db.delete(binding._id);
      }
      for (const binding of await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_role", (q) => q.eq("subjectRoleId", roleId))
        .collect()) {
        await ctx.db.delete(binding._id);
      }
      await ctx.db.delete(role._id);
    }

    async function deleteCatalogRole(roleId: string) {
      await deleteRoleEverywhere(roleId);
    }

    async function deleteTenantRole(roleId: string) {
      await deleteRoleEverywhere(roleId);
    }

    async function upsertPermission(permission: {
      accessScopeId: string;
      permissionId: string;
      key: string;
      resourceType: string;
      action: string;
      classification: "delegable" | "owner_only";
      tenantAssignable: boolean;
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", permission.permissionId))
        .unique();
      if (existing) await ctx.db.replace(existing._id, permission);
      else await ctx.db.insert("permissions", permission);
    }

    async function deletePermission(permissionId: string) {
      const permission = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", permissionId))
        .unique();
      if (!permission) return;

      // Cascade base mappings, overrides, and permission bindings on this perm.
      for (const row of await ctx.db
        .query("role_permissions")
        .withIndex("by_permission", (q) => q.eq("permissionId", permissionId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      for (const row of await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_permission", (q) => q.eq("permissionId", permissionId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      for (const binding of await ctx.db
        .query("permission_bindings")
        .withIndex("by_permission", (q) => q.eq("permissionId", permissionId))
        .collect()) {
        await ctx.db.delete(binding._id);
      }
      await ctx.db.delete(permission._id);
    }

    async function upsertRolePermission(rolePermission: {
      roleId: string;
      permissionId: string;
      effect: "allow" | "deny";
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q.eq("roleId", rolePermission.roleId).eq("permissionId", rolePermission.permissionId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, rolePermission);
      else await ctx.db.insert("role_permissions", rolePermission);
    }

    async function deleteRolePermission(roleId: string, permissionId: string) {
      const row = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q.eq("roleId", roleId).eq("permissionId", permissionId),
        )
        .unique();
      if (row) await ctx.db.delete(row._id);
    }

    async function upsertOverride(override: {
      accessScopeId: string;
      roleId: string;
      permissionId: string;
      effect: "allow" | "deny";
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope_role_permission", (q) =>
          q
            .eq("accessScopeId", override.accessScopeId)
            .eq("roleId", override.roleId)
            .eq("permissionId", override.permissionId),
        )
        .unique();
      if (existing) await ctx.db.replace(existing._id, override);
      else await ctx.db.insert("role_permission_overrides", override);
    }

    async function deleteOverride(accessScopeId: string, roleId: string, permissionId: string) {
      const row = await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope_role_permission", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("roleId", roleId)
            .eq("permissionId", permissionId),
        )
        .unique();
      if (row) await ctx.db.delete(row._id);
    }

    async function upsertRoleBinding(
      binding: {
        bindingId: string;
        subjectPrincipalId: string;
        roleId: string;
        accessScopeId: string;
        resourceType?: string;
        resourceId?: string;
        expiresAt?: number;
        updatedAt: number;
      },
      now: number,
    ) {
      const existing = await ctx.db
        .query("role_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", binding.bindingId))
        .unique();
      if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
        if (existing) await ctx.db.delete(existing._id);
        return;
      }
      if (existing) await ctx.db.replace(existing._id, binding);
      else await ctx.db.insert("role_bindings", binding);
      await scheduleRoleBindingExpiration(binding);
    }

    async function deleteRoleBinding(bindingId: string) {
      const binding = await ctx.db
        .query("role_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
        .unique();
      if (binding) await ctx.db.delete(binding._id);
    }

    async function upsertPermissionBinding(
      binding: {
        bindingId: string;
        subjectPrincipalId?: string;
        subjectRoleId?: string;
        permissionId: string;
        effect: "allow" | "deny";
        accessScopeId: string;
        resourceType?: string;
        resourceId?: string;
        expiresAt?: number;
        updatedAt: number;
      },
      now: number,
    ) {
      const existing = await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", binding.bindingId))
        .unique();
      if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
        if (existing) await ctx.db.delete(existing._id);
        return;
      }
      if (existing) await ctx.db.replace(existing._id, binding);
      else await ctx.db.insert("permission_bindings", binding);
      await schedulePermissionBindingExpiration(binding);
    }

    async function deletePermissionBinding(bindingId: string) {
      const binding = await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
        .unique();
      if (binding) await ctx.db.delete(binding._id);
    }

    async function scheduleRoleBindingExpiration(binding: {
      bindingId: string;
      expiresAt?: number;
      updatedAt: number;
    }) {
      if (binding.expiresAt === undefined) return;
      await ctx.scheduler.runAt(binding.expiresAt, expireRoleBindingReference, {
        bindingId: binding.bindingId,
        expiresAt: binding.expiresAt,
        updatedAt: binding.updatedAt,
      });
    }

    async function schedulePermissionBindingExpiration(binding: {
      bindingId: string;
      expiresAt?: number;
      updatedAt: number;
    }) {
      if (binding.expiresAt === undefined) return;
      await ctx.scheduler.runAt(binding.expiresAt, expirePermissionBindingReference, {
        bindingId: binding.bindingId,
        expiresAt: binding.expiresAt,
        updatedAt: binding.updatedAt,
      });
    }
  },
});

export const expireRoleBinding = internalMutation({
  args: { bindingId: v.string(), expiresAt: v.number(), updatedAt: v.number() },
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("role_bindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", args.bindingId))
      .unique();
    if (!binding || binding.expiresAt !== args.expiresAt || binding.updatedAt !== args.updatedAt) {
      return;
    }
    if (args.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(args.expiresAt, expireRoleBindingReference, args);
      return;
    }
    await ctx.db.delete(binding._id);
  },
});

export const expirePermissionBinding = internalMutation({
  args: { bindingId: v.string(), expiresAt: v.number(), updatedAt: v.number() },
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("permission_bindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", args.bindingId))
      .unique();
    if (!binding || binding.expiresAt !== args.expiresAt || binding.updatedAt !== args.updatedAt) {
      return;
    }
    if (args.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(args.expiresAt, expirePermissionBindingReference, args);
      return;
    }
    await ctx.db.delete(binding._id);
  },
});

function organizationFromScope(scope: ProjectionScopeMetadata) {
  return {
    accessScopeId: scope.accessScopeId,
    name: scope.name,
    status: scope.status,
    accountEntryMode: scope.accountEntryMode,
    updatedAt: scope.updatedAt,
  };
}

function snapshotDocumentCount(snapshot: AccessProjectionSnapshot): number {
  let count =
    snapshot.catalog.roles.length +
    snapshot.catalog.permissions.length +
    snapshot.catalog.rolePermissions.length +
    snapshot.users.length;
  for (const scope of snapshot.scopes) {
    count +=
      1 + // scope (+ possibly an organization row, counted generously below)
      1 +
      scope.principals.length +
      scope.principalMemberships.length +
      scope.roles.length +
      scope.rolePermissionOverrides.length +
      scope.roleBindings.length +
      scope.permissionBindings.length;
  }
  return count;
}
