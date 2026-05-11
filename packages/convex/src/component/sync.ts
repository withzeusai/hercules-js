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

const snapshotArgs = {
  type: v.literal("access.projection.snapshot"),
  schemaVersion: v.literal(1),
  eventId: v.string(),
  accessScopeId: v.string(),
  accessScopeAppId: v.string(),
  projectionId: v.string(),
  sourceVersion: v.number(),
  config: v.object({
    expectedIssuer: v.string(),
    accountEntryMode: accountEntryModeValidator,
    defaultRoleId: v.string(),
  }),
  entities: v.object({
    principals: v.array(
      v.object({
        principalId: v.string(),
        type: v.union(v.literal("user"), v.literal("group")),
        herculesAuthUserId: v.optional(v.string()),
        status: principalStatusValidator,
        updatedAt: v.number(),
      }),
    ),
    principalMemberships: v.array(
      v.object({
        groupPrincipalId: v.string(),
        memberPrincipalId: v.string(),
        updatedAt: v.number(),
      }),
    ),
    roles: v.array(
      v.object({
        roleId: v.string(),
        key: v.string(),
        kind: v.union(v.literal("system"), v.literal("custom")),
        name: v.string(),
        updatedAt: v.number(),
      }),
    ),
    permissions: v.array(
      v.object({
        permissionId: v.string(),
        key: v.string(),
        resourceType: v.string(),
        action: v.string(),
        updatedAt: v.number(),
      }),
    ),
    rolePermissions: v.array(
      v.object({
        roleId: v.string(),
        permissionId: v.string(),
        updatedAt: v.number(),
      }),
    ),
    roleAssignments: v.array(
      v.object({
        assignmentId: v.string(),
        principalId: v.string(),
        roleId: v.string(),
        targetType: targetTypeValidator,
        targetId: v.string(),
        updatedAt: v.number(),
      }),
    ),
  }),
};

export const applySnapshot = mutation({
  args: snapshotArgs,
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("sync_state")
      .withIndex("by_key", (q) => q.eq("key", ACCESS_CONTROL_SYNC_STATE_KEY))
      .unique();

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
      await ctx.db.insert("principals", {
        accessScopeId: args.accessScopeId,
        principalId: principal.principalId,
        type: principal.type,
        herculesAuthUserId: principal.herculesAuthUserId,
        status: principal.status,
        updatedAt: principal.updatedAt,
      });
    }

    for (const membership of args.entities.principalMemberships) {
      await ctx.db.insert("principal_memberships", {
        accessScopeId: args.accessScopeId,
        groupPrincipalId: membership.groupPrincipalId,
        memberPrincipalId: membership.memberPrincipalId,
        updatedAt: membership.updatedAt,
      });
    }

    for (const role of args.entities.roles) {
      await ctx.db.insert("roles", {
        accessScopeId: args.accessScopeId,
        roleId: role.roleId,
        key: role.key,
        kind: role.kind,
        name: role.name,
        updatedAt: role.updatedAt,
      });
    }

    for (const permission of args.entities.permissions) {
      await ctx.db.insert("permissions", {
        accessScopeId: args.accessScopeId,
        permissionId: permission.permissionId,
        key: permission.key,
        resourceType: permission.resourceType,
        action: permission.action,
        updatedAt: permission.updatedAt,
      });
    }

    for (const rolePermission of args.entities.rolePermissions) {
      await ctx.db.insert("role_permissions", {
        accessScopeId: args.accessScopeId,
        roleId: rolePermission.roleId,
        permissionId: rolePermission.permissionId,
        updatedAt: rolePermission.updatedAt,
      });
    }

    for (const assignment of args.entities.roleAssignments) {
      await ctx.db.insert("role_assignments", {
        accessScopeId: args.accessScopeId,
        assignmentId: assignment.assignmentId,
        principalId: assignment.principalId,
        roleId: assignment.roleId,
        targetType: assignment.targetType,
        targetId: assignment.targetId,
        updatedAt: assignment.updatedAt,
      });
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
  },
});
