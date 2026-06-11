# @usehercules/convex

Convex component for Hercules **managed Access Control**: multi-tenant scopes,
roles, permissions, and resource-level grants, enforced inside your Convex
functions. The app reads from a local mirror that Hercules keeps in sync with
the control plane.

> Exact signatures are in the type definitions:
> `node_modules/@usehercules/convex/dist/client/index.d.ts` (builders and
> in-handler checks) and `.../dist/client/access-admin.d.ts` (admin write
> actions). Those are the source of truth — read them rather than guessing.
> REST payload shapes are documented at https://docs-cloud.hercules.app.

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
  listScopeMembers, listScopeRoles, listScopePermissions,
} = createAccessControl({ query, mutation, action, components });

export { scopeFromArg, scopeFromResource } from "@usehercules/convex";
```

## Enforcing access

`accessQuery` / `accessMutation` / `accessAction` take a `permission` and a
`scope`. Resolve the scope with `scopeFromArg` (scope id passed by the caller)
or `scopeFromResource` (scope read from the referenced row). Gate **every**
org-owned read and write this way; `authenticatedQuery` only proves sign-in.

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

> **Matching note:** resource grants are pinned to the permission's canonical
> catalog resource type (`app.project` for `app.project:archive`), and
> `scopeFromResource` defers its resource type to the checked permission, so
> the two always agree; the table name passed to `scopeFromResource` is not
> used for grant matching. When passing an explicit `{ resource }` ref to
> `hasPermission`/`getEffectivePermissions`/`filterAuthorizedResources`, use
> the permission's resource type (e.g. `app.project`), not the table name.

## In-app admin screens

Read the scope's members, roles, and catalog with the `listScope*` helpers.
Each self-gates on the matching `system.*:read` permission and returns `[]`
when the caller lacks it (`owner`/`admin` hold these automatically).

```ts
export const teamMembers = authenticatedQuery({
  args: { scopeId: v.string() },
  handler: async (ctx, args) => listScopeMembers(ctx, { scopeId: args.scopeId }),
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

## Notes

- Reads come from the local mirror, which lags the control plane by a short
  projection-sync window after any change. Treat `undefined` query results and
  a just-changed-but-not-yet-synced state as "loading", not "denied".
- Run `hercules-convex-access-check convex` (the `./checker` export) in lint to
  catch unguarded org-owned access.
