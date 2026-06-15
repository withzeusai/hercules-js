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

## Enforcing access

`accessQuery` / `accessMutation` / `accessAction` take a `permission` and a
`scope`. Choose the scope helper from the app shape:

| App shape | Create/list | Existing row | Child create |
| --- | --- | --- | --- |
| Default app scope | omit `scope` | `scopeFromDefaultResource` | `scopeFromDefaultParentResource` |
| Organization scopes | `scopeFromArg` | `scopeFromResource` | `scopeFromParentResource` |

The default-scope resource helpers load the referenced row but do not require a
scope id column. Organization helpers read or accept the organization scope.
Gate **every** protected read and write; `authenticatedQuery` only proves
sign-in.

```ts
import { v } from "convex/values";
import { accessQuery, accessMutation, scopeFromArg, scopeFromResource } from "./hercules";

// Read: scope from an arg. "view" is a real permission; grant it to every role
// that should see the data, including a read-only role.
export const listProjects = accessQuery({
  permission: "app.project:view",
  scope: scopeFromArg("orgScopeId"),
  args: { orgScopeId: v.string() },
  handler: async (ctx, args) =>
    ctx.db.query("projects").withIndex("by_org", (q) => q.eq("orgScopeId", args.orgScopeId)).collect(),
});

// Write on a specific row: scope from the resource, so the caller cannot pair
// their scope with another org's row.
export const archiveProject = accessMutation({
  permission: "app.project:archive",
  scope: scopeFromResource("projects", "projectId"),
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => ctx.db.patch(args.projectId, { status: "archived" }),
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
    authorizeAgainst: (task) => [{ type: "app.projects", id: String(task.projectId) }],
  }),
  args: { taskId: v.id("tasks"), title: v.string() },
  handler: async (ctx, args) => ctx.db.patch(args.taskId, { title: args.title }),
});

export const createTask = accessMutation({
  permission: "app.tasks:create",
  scope: scopeFromParentResource("projects", "projectId", {
    parentResourceType: "app.projects",
    authorizeAgainst: (project) => [{ type: "app.workspaces", id: String(project.workspaceId) }],
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
  authorizeAgainst: task => [{ type: "app.projects", id: String(task.projectId) }],
})

scope: scopeFromDefaultParentResource("projects", "projectId", {
  parentResourceType: "app.projects",
})
```

## In-app admin screens

Read the scope's members, roles, and catalog with the `listScope*` helpers.
Each self-gates on the matching `system.*:read` permission and returns `[]`
when the caller lacks it (`owner`/`admin` hold these automatically).

For member-facing pickers, use `listScopeMemberDirectory`. It is gated by
`app.members:read` and returns bounded pages of active users with only their
principal id, Hercules Auth user id, name, email, and optional image.

```ts
export const teamMembers = authenticatedQuery({
  args: { scopeId: v.string() },
  handler: async (ctx, args) =>
    listScopeMemberDirectory(ctx, { scopeId: args.scopeId, limit: 50 }),
});
```

### Authority matrix

| Surface                                                                          | Convex exposure                  | Authority                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `createAccessAdminActions`, `createAccessInvitation`, `createResourceInvitation` | Internal only                    | Service via `HERCULES_API_KEY`                                                  |
| `createAccessUserActions`                                                        | Public `authenticatedAction`     | Signed-in app user via `idToken`; the control plane applies runtime role checks |
| `createAccessScopeAction`                                                        | Public `authenticatedAction`     | Authenticated creator after `canCreateScope`; the creator becomes Owner         |
| `createAccessScope`                                                              | App-owned authenticated function | Authenticated creator from `ctx`; the app supplies its own product-policy gate  |
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

Use `replaceMemberRoles` to atomically replace one member's direct scope roles.
Use `replaceResourceGrants` to atomically replace direct grants for each listed
subject; `grants: []` clears that subject. For one grant, use the `grantId`
returned by `createResourceGrant` or `listDirectSubjectsForResource`, then call
`revokeResourceGrant`. Use `listResourceInvitations` and `revokeInvitation` for
pending resource invitations. `setResourcePermissionRules` atomically applies
a rule batch; `effect: "clear"` removes a listed rule.

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
