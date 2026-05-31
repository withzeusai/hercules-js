import {
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const grantObjectTypeValidator = v.union(v.literal("scope"), v.literal("resource"));

const accountEntryModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);

const scopeKindValidator = v.union(v.literal("default"), v.literal("org"), v.literal("suite"));

const scopeStatusValidator = v.union(v.literal("active"), v.literal("disabled"));

const principalStatusValidator = v.union(
  v.literal("active"),
  v.literal("blocked"),
  v.literal("suspended"),
  v.literal("pending_approval"),
);

const userValidator = v.object({
  herculesAuthUserId: v.string(),
  name: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  image: v.optional(v.string()),
  phone: v.optional(v.string()),
  phoneVerified: v.boolean(),
  updatedAt: v.number(),
});

const projectionEntityTypeValidator = v.union(
  v.literal("principal"),
  v.literal("principal_membership"),
  v.literal("role"),
  v.literal("permission"),
  v.literal("role_permission"),
  v.literal("grant"),
);

const projectionOperationValidator = v.union(v.literal("upsert"), v.literal("delete"));

const principalValidator = v.object({
  principalId: v.string(),
  type: v.union(v.literal("user"), v.literal("group")),
  herculesAuthUserId: v.optional(v.string()),
  status: principalStatusValidator,
  joinedAt: v.number(),
  updatedAt: v.number(),
});

const principalMembershipValidator = v.object({
  groupPrincipalId: v.string(),
  memberPrincipalId: v.string(),
  updatedAt: v.number(),
});

const roleValidator = v.object({
  roleId: v.string(),
  // DL15: each role row's owning scope. Default scope for system roles,
  // org scope for custom roles.
  accessScopeId: v.string(),
  key: v.string(),
  kind: v.union(v.literal("system"), v.literal("custom")),
  name: v.string(),
  updatedAt: v.number(),
});

const permissionValidator = v.object({
  permissionId: v.string(),
  // Always the default scope under DL15.
  accessScopeId: v.string(),
  key: v.string(),
  resourceType: v.string(),
  action: v.string(),
  tenantAssignable: v.boolean(),
  updatedAt: v.number(),
});

const rolePermissionValidator = v.object({
  roleId: v.string(),
  permissionId: v.string(),
  // Default scope rows = base; org scope rows = override.
  accessScopeId: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  updatedAt: v.number(),
});

// objectScopeId is intentionally absent on the wire; the producer filters
// grants by objectScopeId === payload.scope.accessScopeId so the consumer
// derives it from the payload tag.
const grantValidator = v.object({
  grantId: v.string(),
  subjectPrincipalId: v.optional(v.string()),
  subjectScopeId: v.optional(v.string()),
  subjectRoleId: v.optional(v.string()),
  // DL15: relationKind="role" requires roleId; "direct_permission"
  // requires permissionId. Producer enforces; consumer trusts after
  // structural validation.
  relationKind: v.union(v.literal("role"), v.literal("direct_permission")),
  roleId: v.optional(v.string()),
  permissionId: v.optional(v.string()),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  objectType: grantObjectTypeValidator,
  objectId: v.string(),
  objectResourceType: v.optional(v.string()),
  appliesToAllResources: v.optional(v.boolean()),
  expiresAt: v.optional(v.number()),
  updatedAt: v.number(),
});

const scopeMetadataValidator = v.object({
  accessScopeId: v.string(),
  name: v.string(),
  kind: scopeKindValidator,
  status: scopeStatusValidator,
  accountEntryMode: accountEntryModeValidator,
  defaultRoleId: v.string(),
  updatedAt: v.number(),
});

const syncPayloadArgs = {
  type: v.union(v.literal("access.projection.snapshot"), v.literal("access.projection.event")),
  schemaVersion: v.literal(1),
  eventId: v.string(),
  sourceVersion: v.number(),
  expectedIssuer: v.optional(v.string()),
  scope: scopeMetadataValidator,
  changes: v.optional(
    v.array(
      v.object({
        entityType: projectionEntityTypeValidator,
        entityId: v.string(),
        operation: projectionOperationValidator,
      }),
    ),
  ),
  entities: v.object({
    users: v.array(userValidator),
    principals: v.array(principalValidator),
    principalMemberships: v.array(principalMembershipValidator),
    roles: v.array(roleValidator),
    permissions: v.array(permissionValidator),
    rolePermissions: v.array(rolePermissionValidator),
    grants: v.array(grantValidator),
  }),
};

export const applySync = mutation({
  args: syncPayloadArgs,
  handler: async (ctx, args) => {
    const state = await ctx.db.query("sync_state").unique();
    const scopeId = args.scope.accessScopeId;
    const deferredUserCleanupIds = new Set<string>();
    const deferUserCleanup = args.type === "access.projection.event";

    if (args.type === "access.projection.event") {
      if (!args.changes) {
        return { ok: false as const, status: "invalid_payload" as const };
      }

      if (!state) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: 0,
          expectedVersion: 1,
          receivedVersion: args.sourceVersion,
        };
      }

      if (args.sourceVersion <= state.sourceVersion) {
        return {
          ok: true as const,
          status: "duplicate" as const,
          acknowledgedVersion: state.sourceVersion,
        };
      }

      const expectedVersion = state.sourceVersion + 1;
      if (args.sourceVersion !== expectedVersion) {
        return {
          ok: false as const,
          status: "version_gap" as const,
          currentVersion: state.sourceVersion,
          expectedVersion,
          receivedVersion: args.sourceVersion,
        };
      }

      const applyChanges: Array<() => Promise<void>> = [];
      for (const change of args.changes) {
        const applyChange = validateChange();
        if (!applyChange) {
          return { ok: false as const, status: "invalid_payload" as const };
        }
        applyChanges.push(applyChange);

        function validateChange(): (() => Promise<void>) | null {
          if (change.operation === "delete") {
            return () => deleteEntity(change.entityType, change.entityId, scopeId);
          }

          switch (change.entityType) {
            case "principal": {
              const principal = args.entities.principals.find(
                (candidate) => candidate.principalId === change.entityId,
              );
              if (!principal) return null;
              return () => upsertPrincipal(scopeId, principal);
            }
            case "principal_membership": {
              const [groupPrincipalId, memberPrincipalId] = change.entityId.split(":");
              if (!groupPrincipalId || !memberPrincipalId) return null;
              const membership = args.entities.principalMemberships.find(
                (candidate) =>
                  candidate.groupPrincipalId === groupPrincipalId &&
                  candidate.memberPrincipalId === memberPrincipalId,
              );
              if (!membership) return null;
              return () => upsertPrincipalMembership(scopeId, membership);
            }
            case "role": {
              const role = args.entities.roles.find(
                (candidate) => candidate.roleId === change.entityId,
              );
              if (!role) return null;
              // DL15: each role row carries its own scope id (default for
              // system roles, target scope for custom roles).
              return () => upsertRole(role.accessScopeId, role);
            }
            case "permission": {
              const permission = args.entities.permissions.find(
                (candidate) => candidate.permissionId === change.entityId,
              );
              if (!permission) return null;
              return () => upsertPermission(permission.accessScopeId, permission);
            }
            case "role_permission": {
              const [roleId, permissionId, effect] = change.entityId.split(":");
              if (!roleId || !permissionId || (effect !== "allow" && effect !== "deny")) {
                return null;
              }
              const rolePermission = args.entities.rolePermissions.find(
                (candidate) =>
                  candidate.roleId === roleId &&
                  candidate.permissionId === permissionId &&
                  candidate.effect === effect,
              );
              if (!rolePermission) return null;
              return () => upsertRolePermission(rolePermission.accessScopeId, rolePermission);
            }
            case "grant": {
              const grant = args.entities.grants.find(
                (candidate) => candidate.grantId === change.entityId,
              );
              if (!grant) return null;
              return () => upsertGrant(scopeId, grant);
            }
            default:
              return null;
          }
        }
      }

      await upsertScope(args.scope);

      for (const user of args.entities.users) {
        await upsertUser(user);
      }
      for (const applyChange of applyChanges) {
        await applyChange();
      }
      for (const herculesAuthUserId of deferredUserCleanupIds) {
        await deleteUserIfUnreferenced(herculesAuthUserId);
      }

      await ctx.db.replace(state._id, {
        ...state,
        sourceVersion: args.sourceVersion,
        lastEventId: args.eventId,
        lastSyncedAt: Date.now(),
      });

      return {
        ok: true as const,
        status: "applied" as const,
        acknowledgedVersion: args.sourceVersion,
      };
    }

    if (!args.expectedIssuer) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    // MED-03: refuse to silently overwrite expectedIssuer with a different
    // value once it has been set. A single misconfigured signed snapshot
    // would otherwise lock every user out at authorize time. Issuer
    // rotation is an explicit operational flow, not a side effect of sync.
    if (state && state.expectedIssuer && state.expectedIssuer !== args.expectedIssuer) {
      return { ok: false as const, status: "issuer_mismatch" as const };
    }

    if (state && args.sourceVersion < state.sourceVersion) {
      return {
        ok: true as const,
        status: "duplicate" as const,
        acknowledgedVersion: state.sourceVersion,
      };
    }

    const clearedAuthUserIds = await clearScopeEntities(scopeId);
    await upsertScope(args.scope);

    for (const user of args.entities.users) {
      await upsertUser(user);
    }
    for (const principal of args.entities.principals) {
      await upsertPrincipal(scopeId, principal);
    }
    for (const membership of args.entities.principalMemberships) {
      await upsertPrincipalMembership(scopeId, membership);
    }
    // DL15: catalog entities carry their own accessScopeId — system roles
    // and permissions live in the default scope, custom roles in their org
    // scope. Use each row's own scope rather than the payload-level scope.
    for (const role of args.entities.roles) {
      await upsertRole(role.accessScopeId, role);
    }
    for (const permission of args.entities.permissions) {
      await upsertPermission(permission.accessScopeId, permission);
    }
    for (const rolePermission of args.entities.rolePermissions) {
      await upsertRolePermission(rolePermission.accessScopeId, rolePermission);
    }
    for (const grant of args.entities.grants) {
      await upsertGrant(scopeId, grant);
    }
    const incomingAuthUserIds = new Set(
      args.entities.principals.flatMap((principal) =>
        principal.herculesAuthUserId ? [principal.herculesAuthUserId] : [],
      ),
    );
    for (const authUserId of clearedAuthUserIds) {
      if (incomingAuthUserIds.has(authUserId)) continue;
      await deleteUserIfUnreferenced(authUserId);
    }

    const nextSourceVersion = state
      ? Math.max(state.sourceVersion, args.sourceVersion)
      : args.sourceVersion;

    const nextState = {
      sourceVersion: nextSourceVersion,
      expectedIssuer: args.expectedIssuer,
      lastEventId: args.eventId,
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
      acknowledgedVersion: nextSourceVersion,
    };

    async function upsertScope(scope: {
      accessScopeId: string;
      name: string;
      kind: "default" | "org" | "suite";
      status: "active" | "disabled";
      accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
      defaultRoleId: string;
      updatedAt: number;
    }) {
      const existing = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", scope.accessScopeId))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, scope);
      } else {
        await ctx.db.insert("scopes", scope);
      }

      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", scope.accessScopeId))
        .unique();
      if (scope.kind !== "org") {
        if (organization) await ctx.db.delete(organization._id);
        return;
      }

      const organizationRow = {
        accessScopeId: scope.accessScopeId,
        name: scope.name,
        status: scope.status,
        accountEntryMode: scope.accountEntryMode,
        updatedAt: scope.updatedAt,
      };
      if (organization) {
        await ctx.db.replace(organization._id, organizationRow);
      } else {
        await ctx.db.insert("organizations", organizationRow);
      }
    }

    function assertSameScope(
      entityKind: string,
      entityId: string,
      existing: { accessScopeId: string } | null,
      incomingScopeId: string,
    ) {
      if (existing && existing.accessScopeId !== incomingScopeId) {
        throw new Error(
          `Refusing to rekey ${entityKind} ${entityId} from scope ${existing.accessScopeId} to ${incomingScopeId}`,
        );
      }
    }

    // Producer guarantees one (grantId, objectScopeId) pairing by filtering
    // grants on objectScopeId === payload.scope.accessScopeId at emission
    // (backend-shared/access-control/projection-event.ts). If a future
    // producer change ever emits the same grantId in two scopes, we fail
    // the mutation rather than silently rekey.
    function assertSameObjectScope(
      grantId: string,
      existing: { objectScopeId: string } | null,
      incomingObjectScopeId: string,
    ) {
      if (existing && existing.objectScopeId !== incomingObjectScopeId) {
        throw new Error(
          `Refusing to rekey grant ${grantId} from objectScope ${existing.objectScopeId} to ${incomingObjectScopeId}`,
        );
      }
    }

    async function clearScopeEntities(accessScopeId: string): Promise<Set<string>> {
      const grantRows = await ctx.db
        .query("grants")
        .withIndex("by_object_scope", (q) => q.eq("objectScopeId", accessScopeId))
        .collect();
      for (const row of grantRows) await ctx.db.delete(row._id);

      const rolePermissionRows = await ctx.db
        .query("role_permissions")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of rolePermissionRows) await ctx.db.delete(row._id);

      const permissionRows = await ctx.db
        .query("permissions")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of permissionRows) await ctx.db.delete(row._id);

      const roleRows = await ctx.db
        .query("roles")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of roleRows) await ctx.db.delete(row._id);

      const membershipRows = await ctx.db
        .query("principal_memberships")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of membershipRows) await ctx.db.delete(row._id);

      const principalRows = await ctx.db
        .query("principals")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of principalRows) await ctx.db.delete(row._id);
      return new Set(
        principalRows.flatMap((row) => (row.herculesAuthUserId ? [row.herculesAuthUserId] : [])),
      );
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
      assertSameScope("principal", principal.principalId, existing, accessScopeId);
      const row = {
        accessScopeId,
        principalId: principal.principalId,
        type: principal.type,
        herculesAuthUserId: principal.herculesAuthUserId,
        status: principal.status,
        joinedAt: principal.joinedAt,
        updatedAt: principal.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
        if (
          existing.herculesAuthUserId &&
          existing.herculesAuthUserId !== principal.herculesAuthUserId
        ) {
          await cleanUpUserIfUnreferenced(existing.herculesAuthUserId);
        }
      } else {
        await ctx.db.insert("principals", row);
      }
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

      if (existing) {
        await ctx.db.replace(existing._id, user);
      } else {
        await ctx.db.insert("users", user);
      }
    }

    async function upsertPrincipalMembership(
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
      const row = {
        accessScopeId,
        groupPrincipalId: membership.groupPrincipalId,
        memberPrincipalId: membership.memberPrincipalId,
        updatedAt: membership.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("principal_memberships", row);
      }
    }

    async function upsertRole(
      accessScopeId: string,
      role: {
        roleId: string;
        key: string;
        kind: "system" | "custom";
        name: string;
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", role.roleId))
        .unique();
      assertSameScope("role", role.roleId, existing, accessScopeId);
      const row = {
        accessScopeId,
        roleId: role.roleId,
        key: role.key,
        kind: role.kind,
        name: role.name,
        updatedAt: role.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("roles", row);
      }
    }

    async function upsertPermission(
      accessScopeId: string,
      permission: {
        permissionId: string;
        key: string;
        resourceType: string;
        action: string;
        tenantAssignable: boolean;
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", permission.permissionId))
        .unique();
      assertSameScope("permission", permission.permissionId, existing, accessScopeId);
      const row = {
        accessScopeId,
        permissionId: permission.permissionId,
        key: permission.key,
        resourceType: permission.resourceType,
        action: permission.action,
        tenantAssignable: permission.tenantAssignable,
        updatedAt: permission.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("permissions", row);
      }
    }

    async function upsertRolePermission(
      accessScopeId: string,
      rolePermission: {
        roleId: string;
        permissionId: string;
        effect: "allow" | "deny";
        updatedAt: number;
      },
    ) {
      // DL15: a single (role, permission) can have both allow and deny
      // override rows in the same org scope. Unique key includes effect.
      const existing = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission_effect", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("roleId", rolePermission.roleId)
            .eq("permissionId", rolePermission.permissionId)
            .eq("effect", rolePermission.effect),
        )
        .unique();
      const row = {
        accessScopeId,
        roleId: rolePermission.roleId,
        permissionId: rolePermission.permissionId,
        effect: rolePermission.effect,
        updatedAt: rolePermission.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("role_permissions", row);
      }
    }

    async function upsertGrant(
      objectScopeId: string,
      grant: {
        grantId: string;
        subjectPrincipalId?: string;
        subjectScopeId?: string;
        subjectRoleId?: string;
        relationKind: "role" | "direct_permission";
        roleId?: string;
        permissionId?: string;
        effect: "allow" | "deny";
        objectType: "scope" | "resource";
        objectId: string;
        objectResourceType?: string;
        appliesToAllResources?: boolean;
        expiresAt?: number;
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("grants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", grant.grantId))
        .unique();
      assertSameObjectScope(grant.grantId, existing, objectScopeId);
      const row = {
        grantId: grant.grantId,
        subjectPrincipalId: grant.subjectPrincipalId,
        subjectScopeId: grant.subjectScopeId,
        subjectRoleId: grant.subjectRoleId,
        relationKind: grant.relationKind,
        roleId: grant.roleId,
        permissionId: grant.permissionId,
        effect: grant.effect,
        objectType: grant.objectType,
        objectId: grant.objectId,
        objectScopeId,
        objectResourceType: grant.objectResourceType,
        appliesToAllResources: grant.appliesToAllResources,
        expiresAt: grant.expiresAt,
        updatedAt: grant.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("grants", row);
      }
    }

    async function deleteEntity(entityType: string, entityId: string, accessScopeId: string) {
      switch (entityType) {
        case "principal":
          await deletePrincipal(entityId, accessScopeId);
          break;
        case "principal_membership":
          await deletePrincipalMembership(entityId, accessScopeId);
          break;
        case "role":
          await deleteRole(entityId, accessScopeId);
          break;
        case "permission":
          await deletePermission(entityId, accessScopeId);
          break;
        case "role_permission":
          await deleteRolePermission(entityId, accessScopeId);
          break;
        case "grant":
          await deleteGrant(entityId);
          break;
      }
    }

    async function deletePrincipal(principalId: string, accessScopeId: string) {
      // Subject-principal grants live keyed by subjectPrincipalId; cascade
      // them when the principal goes away.
      const grantRows = await ctx.db
        .query("grants")
        .withIndex("by_subject_principal_object", (q) => q.eq("subjectPrincipalId", principalId))
        .collect();
      for (const row of grantRows) await ctx.db.delete(row._id);

      const groupRows = await ctx.db
        .query("principal_memberships")
        .withIndex("by_group", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("groupPrincipalId", principalId),
        )
        .collect();
      for (const row of groupRows) await ctx.db.delete(row._id);

      const memberRows = await ctx.db
        .query("principal_memberships")
        .withIndex("by_member", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("memberPrincipalId", principalId),
        )
        .collect();
      for (const row of memberRows) await ctx.db.delete(row._id);

      const principal = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", principalId))
        .unique();
      if (!principal) return;

      await ctx.db.delete(principal._id);
      if (principal.herculesAuthUserId) {
        await cleanUpUserIfUnreferenced(principal.herculesAuthUserId);
      }
    }

    async function cleanUpUserIfUnreferenced(herculesAuthUserId: string) {
      if (deferUserCleanup) {
        deferredUserCleanupIds.add(herculesAuthUserId);
        return;
      }
      await deleteUserIfUnreferenced(herculesAuthUserId);
    }

    async function deleteUserIfUnreferenced(herculesAuthUserId: string) {
      const remainingPrincipal = await ctx.db
        .query("principals")
        .withIndex("by_auth_user", (q) => q.eq("herculesAuthUserId", herculesAuthUserId))
        .first();
      if (remainingPrincipal) return;

      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", herculesAuthUserId))
        .unique();
      if (user) await ctx.db.delete(user._id);
    }

    async function deletePrincipalMembership(entityId: string, accessScopeId: string) {
      const [groupPrincipalId, memberPrincipalId] = entityId.split(":");
      if (!groupPrincipalId || !memberPrincipalId) return;
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

    async function deleteRole(roleId: string, accessScopeId: string) {
      const rolePermissions = await ctx.db
        .query("role_permissions")
        .withIndex("by_role", (q) => q.eq("accessScopeId", accessScopeId).eq("roleId", roleId))
        .collect();
      for (const row of rolePermissions) await ctx.db.delete(row._id);

      // Grants reference roles directly; cascade across all scopes.
      const grants = await ctx.db
        .query("grants")
        .withIndex("by_role", (q) => q.eq("roleId", roleId))
        .collect();
      for (const row of grants) await ctx.db.delete(row._id);

      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique();
      if (role) await ctx.db.delete(role._id);
    }

    async function deletePermission(permissionId: string, accessScopeId: string) {
      const rolePermissions = await ctx.db
        .query("role_permissions")
        .withIndex("by_permission", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("permissionId", permissionId),
        )
        .collect();
      for (const row of rolePermissions) await ctx.db.delete(row._id);

      const permission = await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", permissionId))
        .unique();
      if (permission) await ctx.db.delete(permission._id);
    }

    async function deleteRolePermission(entityId: string, accessScopeId: string) {
      // DL15: entityId is `roleId:permissionId:effect` to disambiguate
      // allow vs deny override rows.
      const [roleId, permissionId, effect] = entityId.split(":");
      if (!roleId || !permissionId || (effect !== "allow" && effect !== "deny")) return;
      const rolePermission = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission_effect", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("roleId", roleId)
            .eq("permissionId", permissionId)
            .eq("effect", effect),
        )
        .unique();
      if (rolePermission) await ctx.db.delete(rolePermission._id);
    }

    async function deleteGrant(grantId: string) {
      const grant = await ctx.db
        .query("grants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", grantId))
        .unique();
      if (grant) await ctx.db.delete(grant._id);
    }
  },
});
