import { v } from "convex/values";
import {
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from "convex/server";
import { ACCESS_CONTROL_SYNC_STATE_KEY } from "../shared/sync";
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

const syncPayloadArgs = {
  type: v.union(v.literal("access.projection.snapshot"), v.literal("access.projection.event")),
  schemaVersion: v.literal(1),
  eventId: v.string(),
  accessScopeId: v.string(),
  accessScopeAppId: v.optional(v.string()),
  projectionId: v.optional(v.string()),
  sourceVersion: v.number(),
  config: v.optional(
    v.object({
      expectedIssuer: v.string(),
      accountEntryMode: accountEntryModeValidator,
      defaultRoleId: v.string(),
    }),
  ),
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
    const state = await ctx.db
      .query("sync_state")
      .withIndex("by_key", (q) => q.eq("key", ACCESS_CONTROL_SYNC_STATE_KEY))
      .unique();

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

      for (const change of args.changes) {
        const applied = await applyChange();
        if (!applied) {
          return { ok: false as const, status: "invalid_payload" as const };
        }

        async function applyChange() {
          if (change.operation === "delete") {
            await deleteEntity(change.entityType, change.entityId, args.accessScopeId);
            return true;
          }

          switch (change.entityType) {
            case "principal": {
              const principal = args.entities.principals.find(
                (candidate) => candidate.principalId === change.entityId,
              );
              if (!principal) return false;
              await upsertPrincipal(args.accessScopeId, principal);
              return true;
            }
            case "principal_membership": {
              const [groupPrincipalId, memberPrincipalId] = change.entityId.split(":");
              if (!groupPrincipalId || !memberPrincipalId) return false;
              const membership = args.entities.principalMemberships.find(
                (candidate) =>
                  candidate.groupPrincipalId === groupPrincipalId &&
                  candidate.memberPrincipalId === memberPrincipalId,
              );
              if (!membership) return false;
              await upsertPrincipalMembership(args.accessScopeId, membership);
              return true;
            }
            case "role": {
              const role = args.entities.roles.find((candidate) => candidate.roleId === change.entityId);
              if (!role) return false;
              await upsertRole(args.accessScopeId, role);
              return true;
            }
            case "permission": {
              const permission = args.entities.permissions.find(
                (candidate) => candidate.permissionId === change.entityId,
              );
              if (!permission) return false;
              await upsertPermission(args.accessScopeId, permission);
              return true;
            }
            case "role_permission": {
              const [roleId, permissionId] = change.entityId.split(":");
              if (!roleId || !permissionId) return false;
              const rolePermission = args.entities.rolePermissions.find(
                (candidate) =>
                  candidate.roleId === roleId && candidate.permissionId === permissionId,
              );
              if (!rolePermission) return false;
              await upsertRolePermission(args.accessScopeId, rolePermission);
              return true;
            }
            case "role_assignment": {
              const assignment = args.entities.roleAssignments.find(
                (candidate) => candidate.assignmentId === change.entityId,
              );
              if (!assignment) return false;
              await upsertRoleAssignment(args.accessScopeId, assignment);
              return true;
            }
            default:
              return false;
          }
        }
      }

      await ctx.db.replace(state._id, {
        ...state,
        sourceVersion: args.sourceVersion,
        lastEventId: args.eventId,
        updatedAt: Date.now(),
      });

      return {
        ok: true as const,
        status: "applied" as const,
        acknowledgedVersion: args.sourceVersion,
      };
    }

    if (!args.config || !args.accessScopeAppId || !args.projectionId) {
      return { ok: false as const, status: "invalid_payload" as const };
    }

    if (state && args.sourceVersion <= state.sourceVersion) {
      return {
        ok: true as const,
        status: "duplicate" as const,
        acknowledgedVersion: state.sourceVersion,
      };
    }

    for (const row of await ctx.db.query("role_assignments").collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("role_permissions").collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("permissions").collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("roles").collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("principal_memberships").collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("principals").collect()) {
      await ctx.db.delete(row._id);
    }

    for (const principal of args.entities.principals) {
      await upsertPrincipal(args.accessScopeId, principal);
    }
    for (const membership of args.entities.principalMemberships) {
      await upsertPrincipalMembership(args.accessScopeId, membership);
    }
    for (const role of args.entities.roles) {
      await upsertRole(args.accessScopeId, role);
    }
    for (const permission of args.entities.permissions) {
      await upsertPermission(args.accessScopeId, permission);
    }
    for (const rolePermission of args.entities.rolePermissions) {
      await upsertRolePermission(args.accessScopeId, rolePermission);
    }
    for (const assignment of args.entities.roleAssignments) {
      await upsertRoleAssignment(args.accessScopeId, assignment);
    }

    const nextState = {
      key: ACCESS_CONTROL_SYNC_STATE_KEY,
      accessScopeId: args.accessScopeId,
      accessScopeAppId: args.accessScopeAppId,
      projectionId: args.projectionId,
      sourceVersion: args.sourceVersion,
      expectedIssuer: args.config.expectedIssuer,
      accountEntryMode: args.config.accountEntryMode,
      defaultRoleId: args.config.defaultRoleId,
      lastEventId: args.eventId,
      updatedAt: Date.now(),
    };

    if (state) {
      await ctx.db.replace(state._id, nextState);
    } else {
      await ctx.db.insert("sync_state", nextState);
    }

    return {
      ok: true as const,
      status: "applied" as const,
      acknowledgedVersion: args.sourceVersion,
    };

    async function upsertPrincipal(
      accessScopeId: string,
      principal: {
        principalId: string;
        type: "user" | "group";
        herculesAuthUserId?: string;
        status: "active" | "blocked" | "suspended" | "pending_approval";
        updatedAt: number;
      },
    ) {
      const existing = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", principal.principalId))
        .unique();
      const row = {
        accessScopeId,
        principalId: principal.principalId,
        type: principal.type,
        herculesAuthUserId: principal.herculesAuthUserId,
        status: principal.status,
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
      membership: {
        groupPrincipalId: string;
        memberPrincipalId: string;
        updatedAt: number;
      },
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
      role: { roleId: string; key: string; kind: "system" | "custom"; name: string; updatedAt: number },
    ) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", role.roleId))
        .unique();
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
          q.eq("accessScopeId", accessScopeId).eq("roleId", roleId).eq("permissionId", permissionId),
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
