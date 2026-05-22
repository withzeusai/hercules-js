import {
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const targetTypeValidator = v.union(
  v.literal("scope"),
  v.literal("app"),
  v.literal("org"),
  v.literal("resource"),
);

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

const projectionEntityTypeValidator = v.union(
  v.literal("principal"),
  v.literal("principal_membership"),
  v.literal("role"),
  v.literal("permission"),
  v.literal("role_permission"),
  v.literal("role_assignment"),
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
  key: v.string(),
  kind: v.union(v.literal("system"), v.literal("custom")),
  name: v.string(),
  updatedAt: v.number(),
});

const permissionValidator = v.object({
  permissionId: v.string(),
  key: v.string(),
  resourceType: v.string(),
  action: v.string(),
  updatedAt: v.number(),
});

const rolePermissionValidator = v.object({
  roleId: v.string(),
  permissionId: v.string(),
  updatedAt: v.number(),
});

const roleAssignmentValidator = v.object({
  assignmentId: v.string(),
  principalId: v.string(),
  roleId: v.string(),
  targetType: targetTypeValidator,
  targetId: v.string(),
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
    principals: v.array(principalValidator),
    principalMemberships: v.array(principalMembershipValidator),
    roles: v.array(roleValidator),
    permissions: v.array(permissionValidator),
    rolePermissions: v.array(rolePermissionValidator),
    roleAssignments: v.array(roleAssignmentValidator),
  }),
};

export const applySnapshot = mutation({
  args: syncPayloadArgs,
  handler: async (ctx, args) => {
    const state = await ctx.db.query("sync_state").unique();
    const scopeId = args.scope.accessScopeId;

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
              return () => upsertRole(scopeId, role);
            }
            case "permission": {
              const permission = args.entities.permissions.find(
                (candidate) => candidate.permissionId === change.entityId,
              );
              if (!permission) return null;
              return () => upsertPermission(scopeId, permission);
            }
            case "role_permission": {
              const [roleId, permissionId] = change.entityId.split(":");
              if (!roleId || !permissionId) return null;
              const rolePermission = args.entities.rolePermissions.find(
                (candidate) =>
                  candidate.roleId === roleId && candidate.permissionId === permissionId,
              );
              if (!rolePermission) return null;
              return () => upsertRolePermission(scopeId, rolePermission);
            }
            case "role_assignment": {
              const assignment = args.entities.roleAssignments.find(
                (candidate) => candidate.assignmentId === change.entityId,
              );
              if (!assignment) return null;
              return () => upsertRoleAssignment(scopeId, assignment);
            }
            default:
              return null;
          }
        }
      }

      await upsertScope(args.scope);

      for (const applyChange of applyChanges) {
        await applyChange();
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

    if (state && args.sourceVersion < state.sourceVersion) {
      return {
        ok: true as const,
        status: "duplicate" as const,
        acknowledgedVersion: state.sourceVersion,
      };
    }

    await clearScopeEntities(scopeId);
    await upsertScope(args.scope);

    for (const principal of args.entities.principals) {
      await upsertPrincipal(scopeId, principal);
    }
    for (const membership of args.entities.principalMemberships) {
      await upsertPrincipalMembership(scopeId, membership);
    }
    for (const role of args.entities.roles) {
      await upsertRole(scopeId, role);
    }
    for (const permission of args.entities.permissions) {
      await upsertPermission(scopeId, permission);
    }
    for (const rolePermission of args.entities.rolePermissions) {
      await upsertRolePermission(scopeId, rolePermission);
    }
    for (const assignment of args.entities.roleAssignments) {
      await upsertRoleAssignment(scopeId, assignment);
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

    async function clearScopeEntities(accessScopeId: string) {
      const assignmentRows = await ctx.db
        .query("role_assignments")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", accessScopeId))
        .collect();
      for (const row of assignmentRows) await ctx.db.delete(row._id);

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
      } else {
        await ctx.db.insert("principals", row);
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
      rolePermission: { roleId: string; permissionId: string; updatedAt: number },
    ) {
      const existing = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("roleId", rolePermission.roleId)
            .eq("permissionId", rolePermission.permissionId),
        )
        .unique();
      const row = {
        accessScopeId,
        roleId: rolePermission.roleId,
        permissionId: rolePermission.permissionId,
        updatedAt: rolePermission.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("role_permissions", row);
      }
    }

    async function upsertRoleAssignment(
      accessScopeId: string,
      assignment: {
        assignmentId: string;
        principalId: string;
        roleId: string;
        targetType: "scope" | "app" | "org" | "resource";
        targetId: string;
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("assignmentId", assignment.assignmentId))
        .unique();
      assertSameScope("role_assignment", assignment.assignmentId, existing, accessScopeId);
      const row = {
        accessScopeId,
        assignmentId: assignment.assignmentId,
        principalId: assignment.principalId,
        roleId: assignment.roleId,
        targetType: assignment.targetType,
        targetId: assignment.targetId,
        updatedAt: assignment.updatedAt,
      };
      if (existing) {
        await ctx.db.replace(existing._id, row);
      } else {
        await ctx.db.insert("role_assignments", row);
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
        case "role_assignment":
          await deleteRoleAssignment(entityId);
          break;
      }
    }

    async function deletePrincipal(principalId: string, accessScopeId: string) {
      const assignmentRows = await ctx.db
        .query("role_assignments")
        .withIndex("by_principal", (q) =>
          q.eq("accessScopeId", accessScopeId).eq("principalId", principalId),
        )
        .collect();
      for (const row of assignmentRows) await ctx.db.delete(row._id);

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
      if (principal) await ctx.db.delete(principal._id);
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

      const assignments = await ctx.db
        .query("role_assignments")
        .withIndex("by_role", (q) => q.eq("accessScopeId", accessScopeId).eq("roleId", roleId))
        .collect();
      for (const row of assignments) await ctx.db.delete(row._id);

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
      const [roleId, permissionId] = entityId.split(":");
      if (!roleId || !permissionId) return;
      const rolePermission = await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q
            .eq("accessScopeId", accessScopeId)
            .eq("roleId", roleId)
            .eq("permissionId", permissionId),
        )
        .unique();
      if (rolePermission) await ctx.db.delete(rolePermission._id);
    }

    async function deleteRoleAssignment(assignmentId: string) {
      const assignment = await ctx.db
        .query("role_assignments")
        .withIndex("by_assignment_id", (q) => q.eq("assignmentId", assignmentId))
        .unique();
      if (assignment) await ctx.db.delete(assignment._id);
    }
  },
});
