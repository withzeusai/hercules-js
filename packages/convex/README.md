# @usehercules/convex

Convex component for Hercules **managed Access Control**: multi-tenant scopes,
roles, permissions, and resource-level grants, enforced inside your Convex
functions. The app reads from a local mirror that Hercules keeps in sync with
the control plane.

This README and the published `dist/client/index.d.ts` and
`dist/client/access-admin.d.ts` files are the authoritative public contract.
Use their TypeScript signatures and your local wrappers. Do not inspect package
or component implementation internals to infer behavior. Public REST payloads
are documented at https://docs-cloud.hercules.app.

## Setup

Call `createAccessControl` once in `convex/hercules.ts` and re-export the
builders. Use these builders instead of the raw `./_generated/server` ones for
anything permissioned.

```ts
import { createAccessControl } from "@usehercules/convex";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

export const {
  publicQuery,
  publicMutation,
  publicAction,
  authenticatedQuery,
  authenticatedMutation,
  authenticatedAction,
  accessQuery,
  accessMutation,
  accessAction,
  hasPermission,
  requirePermission,
  requireAnyPermission,
  getEffectivePermissions,
  getCurrentHerculesAuthUserId,
  listMyMemberships,
  listMyRoles,
  listScopeMembers,
  listScopeMemberDirectory,
  getScopeMemberDirectoryEntry,
  listScopeRoles,
  listScopePermissions,
  listDirectSubjectsForResource,
} = createAccessControl({ query, mutation, action, components });

export {
  scopeFromArg,
  scopeFromDefaultParentResource,
  scopeFromDefaultResource,
  scopeFromParentResource,
  scopeFromResource,
} from "@usehercules/convex";
```

## IAM catalog

`hercules/iam.jsonc` is the only writer for reusable permissions, reusable
roles, base role permissions, and `orgAdminGrantablePermissions`. Runtime APIs
manage members, invitations, groups, organization roles, overrides,
exceptions, and resource access.

```jsonc
{
  "$schema": "https://schemas.hercules.app/iam/v1.json",
  "version": "v1",
  "permissions": {
    "app.documents:read": { "name": "Read documents" },
    "app.documents:update": { "name": "Update documents" },
    "app.documents:manage_members": { "name": "Share documents" },
  },
  "orgAdminGrantablePermissions": [
    "app.documents:read",
    "app.documents:update",
  ],
  "roles": {
    "owner": { "type": "built_in" },
    "admin": { "type": "built_in" },
    "member": { "type": "built_in" },
    "reviewer": { "type": "custom", "name": "Reviewer" },
  },
  "rolePermissions": {
    "member": ["app.documents:read"],
    "reviewer": ["app.documents:read"],
  },
}
```

- Permission keys are `app.<resource>:<action>`.
- Check concrete actions at runtime. Do not check `manage` or `*`.
- Declare `owner` and `admin`, but do not add app-authored base permissions to
  them.
- A resource role that may share its resource needs the exact
  `<resourceType>:manage_members` permission.
- A failed IAM apply means the build failed, even if TypeScript and Vite passed.

## Enforcing access

`accessQuery` / `accessMutation` / `accessAction` take a `permission` and a
`scope`. Choose the scope helper from the app shape:

| App shape           | Create/list    | Existing row               | Child create                     |
| ------------------- | -------------- | -------------------------- | -------------------------------- |
| Default app scope   | omit `scope`   | `scopeFromDefaultResource` | `scopeFromDefaultParentResource` |
| Organization scopes | `scopeFromArg` | `scopeFromResource`        | `scopeFromParentResource`        |

The default-scope resource helpers load the referenced row but do not require a
scope id column. Organization helpers read or accept the organization scope.
Gate **every** protected read and write; `authenticatedQuery` only proves
sign-in.

```ts
import { v } from "convex/values";
import {
  accessQuery,
  accessMutation,
  scopeFromArg,
  scopeFromResource,
} from "./hercules";

// Read: scope from an arg. "view" is a real permission; grant it to every role
// that should see the data, including a read-only role.
export const listProjects = accessQuery({
  permission: "app.project:view",
  scope: scopeFromArg("orgScopeId"),
  args: { orgScopeId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("orgScopeId", args.orgScopeId))
      .collect(),
});

// Write on a specific row: scope from the resource, so the caller cannot pair
// their scope with another org's row.
export const archiveProject = accessMutation({
  permission: "app.project:archive",
  scope: scopeFromResource("projects", "projectId"),
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) =>
    ctx.db.patch(args.projectId, { status: "archived" }),
});
```

### Resource-level (per-resource) permissions

`scopeFromResource` names the specific resource, so a resource grant on that
resource is applied on top of the scope check. `hasPermission` and
`getEffectivePermissions` also accept a `{ resource }` ref for per-resource UI
gating.

Declare trusted parent resources for child authorization. The target and
ancestors are evaluated together with the child permission, so any applicable
deny wins. Parent access applies only when its binding uses
`appliesTo: "self_and_descendants"`.

```ts
export const updateTask = accessMutation({
  permission: "app.tasks:update",
  scope: scopeFromResource("tasks", "taskId", {
    authorizeAgainst: (task) => [
      { type: "app.projects", id: String(task.projectId) },
    ],
  }),
  args: { taskId: v.id("tasks"), title: v.string() },
  handler: async (ctx, args) =>
    ctx.db.patch(args.taskId, { title: args.title }),
});

export const createTask = accessMutation({
  permission: "app.tasks:create",
  scope: scopeFromParentResource("projects", "projectId", {
    parentResourceType: "app.projects",
    authorizeAgainst: (project) => [
      { type: "app.workspaces", id: String(project.workspaceId) },
    ],
  }),
  args: { projectId: v.id("projects"), title: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    return await ctx.db.insert("tasks", {
      orgScopeId: project.orgScopeId,
      projectId: args.projectId,
      title: args.title,
    });
  },
});
```

Keep the requested permission on the child. The helper loads the trusted parent
row, adds that parent first, then appends `authorizeAgainst` ancestors. Use the
default-scope variants for the same recipe without an org scope column.

> **Matching note:** a self-only binding targets the permission resource type.
> A descendant-enabled binding targets the parent resource type while keeping
> the child permission key. Table names are only used to load rows. Explicit
> resource references must use canonical `app.*` types.

For a default-scope app, use the matching helpers without adding a persisted
scope id to each row:

```ts
scope: scopeFromDefaultResource("tasks", "taskId", {
  authorizeAgainst: (task) => [
    { type: "app.projects", id: String(task.projectId) },
  ],
});

scope: scopeFromDefaultParentResource("projects", "projectId", {
  parentResourceType: "app.projects",
});
```

## Identity and app relationships

Use `getCurrentHerculesAuthUserId` for the stable Hercules Auth user id. It
returns the verified OIDC `sub`; never parse `tokenIdentifier`.

```ts
export const getMyProfile = accessQuery({
  permission: "app.profiles:read",
  args: {},
  handler: async (ctx) => {
    const herculesAuthUserId = await getCurrentHerculesAuthUserId(ctx);
    if (!herculesAuthUserId) throw new Error("Authentication required");
    return await ctx.db
      .query("profiles")
      .withIndex("by_auth_user", (q) =>
        q.eq("herculesAuthUserId", herculesAuthUserId),
      )
      .unique();
  },
});
```

Application tables own product relationships such as owner, assignee,
attending user, or linked profile. Access Control owns capabilities. Enforce
both:

1. Gate the function with a concrete Access Control permission.
2. Load the trusted application row.
3. Apply any relationship-based row or field restriction.

A relationship may narrow an authorized result; it must not grant a capability
by itself. Use a managed resource grant when the relationship should confer
additional access.

## In-app admin screens

Read the scope's members, roles, and catalog with the `listScope*` helpers.
Each self-gates on the matching `system.*:read` permission and returns `[]`
when the caller lacks it (`owner`/`admin` hold these automatically).

For member-facing pickers, use `listScopeMemberDirectory`. It is gated by
`app.members:read` and returns bounded pages of active users with only their
principal id, Hercules Auth user id, name, email, optional image, and
authoritative effective scope-role keys.

```ts
export const teamMembers = authenticatedQuery({
  args: { scopeId: v.string() },
  handler: async (ctx, args) => {
    const page = await listScopeMemberDirectory(ctx, { scopeId: args.scopeId, limit: 50 });
    return {
      ...page,
      members: page.members.filter((member) => member.roleKeys.includes("reviewer")),
    };
  },
});
```

`roleKeys` comes from managed scope-role bindings, including active group
membership. Do not copy it into an app-owned role table.

### Authority matrix

| Surface                                                                          | Convex exposure                  | Authority                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `createAccessAdminActions`, `createAccessInvitation`, `createResourceInvitation` | Internal only                    | Service via `HERCULES_API_KEY`                                                  |
| `createAccessUserActions`                                                        | Public `authenticatedAction`     | Signed-in app user via `idToken`; the control plane applies runtime role checks |
| `createAccessScopeAction`                                                        | Public `authenticatedAction`     | Authenticated creator after `canCreateScope`; the creator becomes Owner         |
| `createAccessScope`                                                              | App-owned authenticated function | Authenticated creator from `ctx`; the app supplies its own product-policy gate  |
| `createResourceCreatorBootstrapAction`                                           | Public `authenticatedAction`     | Trusted resource creator; one fixed initial resource role                       |
| `acceptAccessInvitation`                                                         | App-owned authenticated function | Invitee identified by the invitation token and `idToken`                        |

Never call generated `internal.accessAdmin.*` actions from an exported public,
authenticated, or access builder, directly or through a helper. Service
authority is only for trusted internal workflows.

```ts
"use node";
import { createAccessAdminActions } from "@usehercules/convex/access-admin";
import { internalAction } from "./_generated/server";

export const { assignRole, removeRole, createInvitation } =
  createAccessAdminActions({ internalAction });
```

Use `createAccessUserActions` for user-initiated administration.

```ts
"use node";
import { createAccessUserActions } from "@usehercules/convex/access-admin";
import { authenticatedAction } from "./hercules";

export const {
  assignRole,
  replaceMemberRoles,
  listGrantableRoles,
  createResourceGrant,
  replaceResourceGrants,
  revokeResourceGrant,
  setResourcePermissionRules,
  listResourceInvitations,
  revokeInvitation,
} = createAccessUserActions({ authenticatedAction });
```

`idToken` authenticates the actor only. In trusted Convex code, load the
resource row to derive its scope and resource id, use its canonical `app.*`
resource type, and resolve a selected `herculesAuthUserId` with
`getScopeMemberDirectoryEntry`; pass the returned `principalId` as the
recipient. Do not trust a browser-supplied principal or scope/resource pair.

Use `listGrantableRoles` for role pickers. It returns only roles the current
actor may confer at the exact scope or resource target. Set `subjectType` to
match the intended user or group recipient:

```ts
await ctx.runAction(api.accessUser.listGrantableRoles, {
  scopeId,
  subjectType: "user",
  target: {
    type: "resource",
    resourceType: "app.documents",
    resourceId: String(documentId),
    appliesTo: "self",
  },
  idToken,
});
```

Do not use `listScopeRoles` for a write picker. It is the complete mirrored
catalog for administrators and may include roles the current actor cannot
assign at that target. The write still reauthorizes after a picker result.

Common public action calls:

```ts
await ctx.runAction(api.accessUser.replaceMemberRoles, {
  scopeId,
  herculesAuthUserId,
  roleKeys: ["reviewer"],
  idToken,
});

await ctx.runAction(api.accessUser.createInvitation, {
  scopeId,
  email,
  roleKeys: ["member"],
  idToken,
});

await ctx.runAction(api.accessUser.replaceResourceGrants, {
  scopeId,
  resourceType: "app.documents",
  resourceId: String(documentId),
  subjects: [{ principalId, grants: [{ roleKey: "reviewer" }] }],
  idToken,
});
```

### Give a resource creator its initial manager role

When creating a resource should make its creator the resource manager, use
`createResourceCreatorBootstrapAction`. It is deliberately narrower than a
normal grant action:

- the browser passes only the resource id;
- trusted app data supplies the creator and scope;
- the resource type, role, and descendant behavior are fixed in code;
- the caller must still be an active member of the scope; and
- an active resource is never bootstrapped again, so revoked access is not
  silently restored.

Create the app row as `provisioning`, record its creator with
`getCurrentHerculesAuthUserId`, and exclude provisioning rows from normal
queries. Then expose one action:

```ts
// convex/accessUser.ts
"use node";

import { createResourceCreatorBootstrapAction } from "@usehercules/convex/access-admin";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { authenticatedAction, listMyMemberships } from "./hercules";

export const bootstrapProjectCreator =
  createResourceCreatorBootstrapAction({
    authenticatedAction,
    resourceType: "app.projects",
    managerRoleKey: "project_manager",
    appliesTo: "self_and_descendants",
    listMyMemberships,
    getBootstrapTarget: async (ctx, { resourceId }) =>
      await ctx.runQuery(internal.projects.getCreatorBootstrapTarget, {
        projectId: resourceId as Id<"projects">,
      }),
    activateResource: async (
      ctx,
      { resourceId, creatorHerculesAuthUserId },
    ) => {
      await ctx.runMutation(internal.projects.activateCreatorBootstrap, {
        projectId: resourceId as Id<"projects">,
        creatorHerculesAuthUserId,
      });
    },
  });
```

The internal query returns only `{ scopeId, resourceId,
creatorHerculesAuthUserId, state }`. The activation mutation must re-read the
row and require the same creator plus `state === "provisioning"` before
changing it to `active`. If activation fails after the grant, retry the action;
the managed grant write is idempotent.

Do not accept a browser-supplied scope, role, resource type, or recipient, and
do not expose a raw service-authority action. If every scope Admin should
already manage every resource, skip creator bootstrap entirely: the built-in
Admin role already covers ordinary `app.*` permissions.

For a browser-selected user, resolve active scope membership before writing:

```ts
const recipient = await getScopeMemberDirectoryEntry(ctx, {
  scopeId,
  herculesAuthUserId,
});
if (!recipient) throw new Error("Active member not found");
```

Grant `app.members:read` to roles that may use a member-facing directory.
Access-administration screens should use `listScopeMembers`, which requires
`system.members:read`.

Use `replaceMemberRoles` to atomically replace up to 500 direct scope roles for
one member.
Use `replaceResourceGrants` to atomically replace direct grants for each listed
subject; `grants: []` clears that subject. Each request must include 1-100
subjects and may involve at most 500 distinct existing or desired grants. Split
larger edits by subjects, never by one subject's complete grant set.
`createResourceGrant` requires one exact `resourceId`. For one grant, use its
returned `grantId` or
`listDirectSubjectsForResource`, then call `revokeResourceGrant`. Use
`listResourceInvitations` and `revokeInvitation` for pending resource
invitations. `setResourcePermissionRules` atomically applies a rule batch;
`effect: "clear"` removes a listed rule.

Create organization scopes with `createAccessScopeAction` or
`createAccessScope`. The authenticated creator is sent as the scope Owner
automatically; do not create a second self-grant.

## Notes

- Reads come from the local mirror, which lags the control plane by a short
  projection-sync window after any change. Treat `undefined` query results and
  a just-changed-but-not-yet-synced state as "loading", not "denied".
- Run `hercules-convex-access-check convex` (the `./checker` export) in lint to
  catch deterministic source patterns. It is static and does not prove runtime
  role decisions or control-plane writes are authorized.
- Before claiming completion, exercise at least one intended allow, one denied
  operation, one cross-row or cross-scope isolation case, and each sensitive
  field-redaction path with real non-Owner identities.
