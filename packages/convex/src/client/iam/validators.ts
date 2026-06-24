import { v } from "convex/values";

export const roleReferenceValidator = v.union(
  v.object({ id: v.string() }),
  v.object({ key: v.string() }),
);

export const accountEntryModeValidator = v.union(
  v.literal("open"),
  v.literal("allowlisted_only"),
  v.literal("invite_only"),
  v.literal("approval_required"),
);

export const appliesToValidator = v.union(v.literal("self"), v.literal("self_and_descendants"));

export const userActionValidator = v.union(
  v.literal("approve"),
  v.literal("activate"),
  v.literal("suspend"),
);

export const permissionOverrideValidator = v.object({
  permissionKey: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
});

export const permissionGrantValidator = v.object({
  permissionKey: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  expiresAt: v.optional(v.union(v.string(), v.null())),
});

export const roleGrantValidator = v.object({
  role: roleReferenceValidator,
  expiresAt: v.optional(v.union(v.string(), v.null())),
});

export const resourceInvitationPermissionGrantValidator = v.object({
  permissionKey: v.string(),
  expiresAt: v.optional(v.union(v.string(), v.null())),
});

export const resourcePermissionOverrideValidator = v.object({
  permissionKey: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  expiresAt: v.optional(v.union(v.string(), v.null())),
});

export const resourceSubjectValidator = v.union(
  v.object({ type: v.literal("user"), userId: v.string() }),
  v.object({ type: v.literal("group"), groupId: v.string() }),
);

export const resourcePermissionSubjectValidator = v.union(
  resourceSubjectValidator,
  v.object({ type: v.literal("role"), role: roleReferenceValidator }),
);

export const grantableRoleTargetValidator = v.union(
  v.object({ type: v.literal("tenant") }),
  v.object({
    type: v.literal("resource"),
    resourceType: v.string(),
    resourceId: v.string(),
    appliesTo: v.optional(appliesToValidator),
  }),
);
