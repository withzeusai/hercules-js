# @usehercules/convex

Convex component for Hercules **managed Access Control**: multi-tenant scopes,
roles, permissions, and resource-level grants, enforced inside your Convex
functions. The app reads from a local mirror that Hercules keeps in sync with
the control plane.

Start with this README and the generated wrappers in `convex/hercules.ts`,
`convex/accessUser.ts`, and `convex/accessOrgAdmin.ts`. These are the supported
public integration surface. Do not inspect component internals for normal app
setup. TypeScript exposes exact signatures at the call site; public REST
payloads are documented at https://docs-cloud.hercules.app.

## Setup

Call `createAccessControl` once in `convex/hercules.ts` and re-export the
builders. Use these builders instead of the raw `./_generated/server` ones for
anything permissioned.

```ts
import { createAccessControl } from "@usehercules/convex";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

export const {
  publicQuery, publicMutation, publicAction,
  authenticatedQuery, authenticatedMutation, authenticatedAction,
  accessQuery, accessMutation, accessAction,
  hasPermission, requirePermission, requireAnyPermission, getEffectivePermissions,
  listMyMemberships, listMyRoles,
  listScopeMembers, listScopeMemberDirectory, listScopeRoles, listScopePermissions,
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
scope: scopeFromResource("tasks", "taskId", {
  authorizeAgainst: task => [{ type: "app.projects", id: String(task.projectId) }],
})

scope: scopeFromParentResource("projects", "projectId", {
  parentResourceType: "app.projects",
})
```

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

Service-authority access changes use `createAccessAdminActions` from
`@usehercules/convex/access-admin`. These actions need the `HERCULES_API_KEY`
secret and must remain internal.

```ts
"use node";
import { createAccessAdminActions } from "@usehercules/convex/access-admin";
import { internalAction } from "./_generated/server";

export const { assignRole, removeRole, createInvitation } =
  createAccessAdminActions({ internalAction });
```

For public organization or resource administration, use
`createAccessUserActions`. Every call requires the signed-in user's nonempty
Hercules ID token and sends `actor_mode: "app_user"`. The control plane applies
the operation's scope, Owner, or resource-level RBAC gate; for example, a
resource manager can share that resource without scope-wide admin authority.

```ts
"use node";
import { createAccessUserActions } from "@usehercules/convex/access-admin";
import { authenticatedAction } from "./hercules";

export const { assignRole, createInvitation, createResourceGrant, createResourceInvitation } =
  createAccessUserActions({ authenticatedAction });
```

The actor and recipient are separate. Pass `user.id_token` as `idToken` to
authenticate the caller. Pass `principalId` or `herculesAuthUserId` to select
who receives the grant. There is no implicit self target, and targeting the
caller does not bypass the normal authorization gate.

```ts
await createResourceGrant({
  scopeId,
  resourceType: "app.projects",
  resourceId: String(projectId),
  roleKey: "project_manager",
  herculesAuthUserId: user.profile.sub,
  idToken: user.id_token,
});
```

`user.profile.sub` is valid above only because the field explicitly asks for
the recipient's Hercules Auth user id. Never pass it as `idToken`.

Create organization scopes with `createAccessScopeAction` or
`createAccessScope`. The authenticated creator is sent as the scope Owner
automatically; do not create a second self-grant.

## Notes

- Reads come from the local mirror, which lags the control plane by a short
  projection-sync window after any change. Treat `undefined` query results and
  a just-changed-but-not-yet-synced state as "loading", not "denied".
- Run `hercules-convex-access-check convex` (the `./checker` export) in lint to
  catch unguarded org-owned access.
