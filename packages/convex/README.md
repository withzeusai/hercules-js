# @usehercules/convex

Convex integration for Hercules-managed IAM. The public model uses one term:
**tenant**. The default app tenant and additional product tenants use the same
APIs.

Use this package for authorization builders, mirrored reads, webhook routes, and
the fixed creator-bootstrap helper. Use the generated `@usehercules/sdk` client
directly from Convex actions for IAM writes and REST reads.

The generated `.d.ts` files are the exact TypeScript contract. Do not infer
public behavior from component implementation files.

## Setup

Wire IAM once in `convex/iam.ts`:

```ts
import { createIam } from "@usehercules/convex";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

export const {
  publicQuery,
  publicMutation,
  publicAction,
  authenticatedQuery,
  authenticatedMutation,
  authenticatedAction,
  iamQuery,
  iamMutation,
  iamAction,
  hasPermission,
  requirePermission,
  requireAnyPermission,
  checkPermissions,
  filterAuthorizedResources,
  getCurrentHerculesAuthUserId,
  getTenantAccessStatus,
  getEffectivePermissions,
  listMyTenants,
  listMyActiveTenants,
  getTargetTenantSyncStatus,
  listMyRoles,
  getTenant,
  listTenantUsers,
  listTenantGroups,
  listTenantUserDirectory,
  listTenantMemberPickerUsers,
  listResourceSharingRecipients,
  getTenantUserDirectoryEntry,
  listGroupMembers,
  listUserGroups,
  listTenantRoles,
  getTenantRole,
  listTenantPermissions,
  getResourcePermissionOverrides,
  explainAccess,
  listDirectSubjectsForResource,
} = createIam({ query, mutation, action, components });

export {
  defaultTenant,
  tenantFromArg,
  tenantFromDefaultParentResource,
  tenantFromDefaultResource,
  tenantFromParentResource,
  tenantFromResource,
} from "@usehercules/convex";
```

Keep this as the main IAM wiring file. Add app-owned Convex action modules only
when the app needs IAM writes. IAM actions use Convex's default runtime. Do not
add `"use node"`.

## Catalog

`hercules/iam.jsonc` owns reusable permissions, reusable roles, and base role
permissions.

```jsonc
{
  "$schema": "https://schemas.hercules.app/iam/v1.json",
  "version": "v1",
  "permissions": {
    "app.documents:read": { "name": "Read documents" },
    "app.documents:update": { "name": "Update documents" },
    "app.documents:manage_members": { "name": "Share documents" },
  },
  "tenantAdminGrantablePermissions": ["app.documents:read", "app.documents:update"],
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

- Runtime permission checks use concrete keys such as
  `app.documents:update`. Do not check `manage` or `*`.
- Permission checks do not filter database rows. Queries must still select rows
  belonging to the requested tenant and resource.
- Do not infer authorization from role names or `listMyRoles`.

## Authorization

`iamQuery`, `iamMutation`, and `iamAction` require a `permission`. Their
optional `tenant` extractor defaults to the app's default tenant.

| Operation    | Default tenant                         | Explicit tenant                 |
| ------------ | -------------------------------------- | ------------------------------- |
| Create/list  | omit `tenant`                          | `tenantFromArg("tenantId")`     |
| Existing row | `tenantFromDefaultResource(...)`       | `tenantFromResource(...)`       |
| Child create | `tenantFromDefaultParentResource(...)` | `tenantFromParentResource(...)` |

For an existing row, derive the tenant from the loaded row. Do not accept both a
row id and a browser-supplied tenant id.

```ts
import { v } from "convex/values";
import { iamMutation, iamQuery, tenantFromArg, tenantFromResource } from "./iam";

export const listProjects = iamQuery({
  permission: "app.projects:read",
  tenant: tenantFromArg("tenantId"),
  args: { tenantId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("projects")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .collect(),
});

export const archiveProject = iamMutation({
  permission: "app.projects:archive",
  tenant: tenantFromResource("projects", "projectId"),
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => ctx.db.patch(args.projectId, { status: "archived" }),
});
```

Use `authorizeAgainst` for trusted parent relationships:

```ts
tenant: tenantFromResource("tasks", "taskId", {
  authorizeAgainst: (task) => [
    { type: "app.projects", id: String(task.projectId) },
  ],
}),
```

The target and ancestors are evaluated atomically. An applicable deny wins.

`filterAuthorizedResources` filters a bounded page of app-owned rows with the
canonical `authorizeMany` gate in chunks of at most 50 checks. It does not load
or paginate app data.

Use it only after an indexed app-owned `.paginate` call, and pass only
`page.page`:

```ts
const page = await ctx.db
  .query("documents")
  .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
  .paginate(args.paginationOpts);

const documents = await filterAuthorizedResources(ctx, {
  resources: page.page,
  tenantId: args.tenantId,
  permission: "app.documents:read",
  resource: (document) => ({ type: "app.documents", id: document._id }),
  ancestors: (document) => [{ type: "app.folders", id: document.folderId }],
});

return { ...page, page: documents };
```

Return the original `continueCursor` and done state even when the authorized
page is sparse. Do not call `.collect()`, do not treat a fixed limit as a
complete list, and do not loop unbounded to fill an authorized page. No generic
abstraction should hide or forge Convex cursors.

## Mirrored Reads

Reads come from the local Convex mirror:

- `getTenantAccessStatus(ctx)`
- `listMyTenants(ctx, { cursor, limit })`
- `listMyActiveTenants(ctx, { cursor, limit, kind })`
- `getTargetTenantSyncStatus(ctx, { tenantId, sourceVersion })`
- `listMyRoles(ctx, { tenantId })`
- `getEffectivePermissions(ctx, { tenantId, resource })`
- `getTenant(ctx, { tenantId })`
- `listTenantUsers(ctx, { tenantId, cursor, limit })`
- `listTenantGroups(ctx, { tenantId, cursor, limit })`
- `listTenantUserDirectory(ctx, { tenantId, cursor, limit })`
- `listTenantMemberPickerUsers(ctx, { tenantId, permission, resource, ancestors, cursor, limit })`
- `listResourceSharingRecipients(ctx, args)`
- `getTenantUserDirectoryEntry(ctx, { tenantId, userId })`
- `listGroupMembers(ctx, { tenantId, groupId, cursor, limit })`
- `listUserGroups(ctx, { tenantId, userId, cursor, limit })`
- `listTenantRoles(ctx, { tenantId })`
- `getTenantRole(ctx, { tenantId, roleId })`
- `listTenantPermissions(ctx, { tenantId })`
- `getResourcePermissionOverrides(ctx, args)`
- `explainAccess(ctx, args)`
- `listDirectSubjectsForResource(ctx, { tenantId, resourceType, resourceId, cursor, limit })`

User and group reads are separate. Tenant APIs use `user`; group APIs use
`member`.

`getTenantAccessStatus` returns the signed-in user's access status in the
default app tenant, or a typed fallback when that status is unavailable.
`listMyTenants` returns `{ tenants, nextCursor? }`; each tenant summary uses
`accessStatus` for the signed-in user's principal and `lifecycleStatus` for the
tenant. It includes an archived tenant only for its retained active direct
built-in Owner, with `lifecycleStatus: "archived"`; use the authoritative SDK
tenant lifecycle reads for complete archive-management views.
`listMyActiveTenants` returns only active memberships in active tenants and
narrows both statuses to `"active"`. Pass `kind: "default"` or
`kind: "custom"` to filter without assuming array order.
Custom tenant results require active standing in the default app tenant. When
default standing is inactive, `listMyTenants` may still expose the default
tenant's own `accessStatus` for boundary UI but omits custom tenants, and
`listMyActiveTenants` returns an empty page.
`listTenantUsers` returns `{ users, nextCursor? }`. `listTenantGroups` returns
`{ groups, nextCursor? }`. Each page contains at most 100 records. User and
group rows include `directRoleGrants` with full role grant shape and nullable
expiry. Effective `roles` may include roles inherited through groups.
`listTenantGroups` includes the current direct `memberCount`.

`listGroupMembers` returns `{ users, nextCursor? }`, `listUserGroups` returns
`{ groups, nextCursor? }`, and `listDirectSubjectsForResource` returns
`{ subjects, nextCursor? }`. These reads cap pages at 100 records.
`getTenantRole` includes the description, base permissions, tenant overrides,
and effective permissions. `listDirectSubjectsForResource` requires
`system.access.grants:read` in the tenant.

Use `listTenantMemberPickerUsers` for least-privilege app pickers such as task
assignment. The trusted server call site supplies the concrete app permission
for the operation, for example `app.tasks:assign`. Pass optional `resource` and
trusted `ancestors` when the protected operation is resource-scoped; omit them
for tenant-level operations. The helper returns only active users with
picker-safe fields: `userId`, `name`, `email`, and optional `image`.

Use `listResourceSharingRecipients` for exact-resource sharing pickers. Supply
the concrete resource permission for the target resource type with action
exactly `manage_members`, the exact `{ resourceType, resourceId }`, optional
trusted ancestors, and one `recipientType` (`"user"` or `"group"`). The helper
returns only active users or active groups with picker-safe fields and returns
an empty page when the caller is unauthenticated, not authorized, or supplies a
permission that resolves to any other resource type or action.

Select the default app tenant by `kind`, not array order:

```ts
const { tenants } = await listMyTenants(ctx, { limit: 100 });
const tenant = tenants.find(({ kind }) => kind === "default");
if (!tenant) throw new Error("Default IAM tenant not found");
```

After a control-plane write that returns `sourceVersion`, keep that value and
call `getTargetTenantSyncStatus(ctx, { tenantId, sourceVersion })` before
treating target-tenant mirror reads as complete. A `syncing` result means the
local mirror has not reached the write yet. `ready` means the target tenant,
target principal, and default app standing are active after the barrier.
`denied` is a completed access denial after the barrier. `failed` means the
identity, issuer, mirror, or target tenant is invalid after the promised
version. Do not treat missing target mirror data before the barrier as denial.

`listTenantRoles` is the complete mirrored role catalog. Back tenant assignment
pickers with `hercules.iam.tenants.grantableRoles` and exact resource pickers
with `hercules.iam.tenants.resources.accessGrantingRoles`.

## IAM Actions

Create app-owned Convex actions for IAM writes and REST reads. Call the
generated SDK directly.

```ts
import { Hercules } from "@usehercules/sdk";
import { v } from "convex/values";
import { authenticatedAction } from "./iam";

const hercules = new Hercules({ apiKey: process.env.HERCULES_API_KEY! });

export const updateTenantUser = authenticatedAction({
  args: {
    tenantId: v.string(),
    userId: v.string(),
    roleGrants: v.array(
      v.object({
        roleId: v.string(),
        expiresAt: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.tokenIdentifier) throw new Error("Authentication required");
    return await hercules.iam.tenants.users.update(args.userId, {
      tenant_id: args.tenantId,
      roles: args.roleGrants.map(({ roleId, expiresAt }) => ({
        role: { id: roleId },
        expires_at: expiresAt,
      })),
      user_token_identifier: identity.tokenIdentifier,
    });
  },
});
```

For `authenticatedAction` and `iamAction` handlers:

1. Get `identity = await ctx.auth.getUserIdentity()`.
2. Require `identity?.tokenIdentifier`.
3. Pass `user_token_identifier: identity.tokenIdentifier` in the SDK request.

Never accept `user_token_identifier` from action args. Browser code uses
`useAction` and passes business args only. The browser never supplies ID tokens
or token identifiers.

SDK request and query fields use snake_case. Keep Convex action args app-facing,
then map them to SDK fields such as `tenant_id`, `resource_type`,
`access_mode`, `default_role`, `applies_to`, `expires_at`, and
`user_token_identifier`.

Pass the deepest path identifier as the positional argument. Put ancestor path
fields in the request object. For example,
`hercules.iam.tenants.users.update(userId, { tenant_id, ... })` takes `userId`
positionally. It does not take `tenantId` and `userId` as two positional
arguments.

Trusted `internalAction` service workflows call the same SDK methods and pass
`user_token_identifier: null`:

```ts
import { Hercules } from "@usehercules/sdk";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const hercules = new Hercules({ apiKey: process.env.HERCULES_API_KEY! });

export const unarchiveTenantForBilling = internalAction({
  args: { tenantId: v.string() },
  handler: async (_, args) =>
    hercules.iam.tenants.unarchive(args.tenantId, {
      user_token_identifier: null,
    }),
});
```

## Round-3 IAM Operations

Use these generated SDK operations as the source of truth:

- Tenants: `hercules.iam.tenants.create`, `hercules.iam.tenants.update`,
  `hercules.iam.tenants.archive`, `hercules.iam.tenants.unarchive`,
  `hercules.iam.tenants.evaluateAccess`, and
  `hercules.iam.tenants.grantableRoles`
- Users: `hercules.iam.tenants.users.create`,
  `hercules.iam.tenants.users.update`, and
  `hercules.iam.tenants.users.remove`
- User permission overrides:
  `hercules.iam.tenants.users.permissionOverrides.get` and
  `hercules.iam.tenants.users.permissionOverrides.update`
- Tenant grants: `hercules.iam.tenants.grants.update` and
  `hercules.iam.tenants.grants.delete`
- Groups: `hercules.iam.tenants.groups.create`,
  `hercules.iam.tenants.groups.update`,
  `hercules.iam.tenants.groups.archive`, and
  `hercules.iam.tenants.groups.unarchive`
- Group members: `hercules.iam.tenants.groups.members.add` and
  `hercules.iam.tenants.groups.members.remove`
- Group permission overrides:
  `hercules.iam.tenants.groups.permissionOverrides.get` and
  `hercules.iam.tenants.groups.permissionOverrides.update`
- Roles: `hercules.iam.tenants.roles.create`,
  `hercules.iam.tenants.roles.update`,
  `hercules.iam.tenants.roles.archive`, and
  `hercules.iam.tenants.roles.unarchive`
- Role permission overrides:
  `hercules.iam.tenants.roles.permissionOverrides.get` and
  `hercules.iam.tenants.roles.permissionOverrides.update`
- Admission rules: `hercules.iam.tenants.admissionRules.list`,
  `hercules.iam.tenants.admissionRules.create`,
  `hercules.iam.tenants.admissionRules.update`,
  `hercules.iam.tenants.admissionRules.archive`, and
  `hercules.iam.tenants.admissionRules.unarchive`
- Audit events: `hercules.iam.tenants.auditEvents.list`
- Tenant invitations: `hercules.iam.tenants.invitations.list`,
  `hercules.iam.tenants.invitations.createTenant`,
  `hercules.iam.tenants.invitations.createResource`, and
  `hercules.iam.tenants.invitations.revoke`
- Invitation acceptance: `hercules.iam.invitations.accept`
- Resource access: `hercules.iam.tenants.resources.accessGrantingRoles`,
  `hercules.iam.tenants.resources.grants.create`,
  `hercules.iam.tenants.resources.grants.update`, and
  `hercules.iam.tenants.resources.permissionOverrides.update`

Role references are exactly `{ id }` or `{ key }`. Include `roles` in
the generated user create/update and group update request objects for complete
direct tenant role sets. Use `suspend` and `unsuspend` for user or group status.

`hercules.iam.tenants.update` accepts request fields `name`, `access_mode`, and
`default_role`. Access modes are `open`, `allowlisted_only`, `invite_only`, and
`approval_required`.

`hercules.iam.tenants.invitations.list` accepts `cursor`, `limit`, `email`, and
one optional typed `target`. Use `{ type: "tenant" }`,
`{ type: "resource" }`, or
`{ type: "resource", resource_type, resource_id }`; omit `target` to list all
invitations. Use the returned `accept_url` for invite UI.

App-owned audit action args may use `startTime`, `endTime`, and `status`. Map
them to SDK query fields `start_time`, `end_time`, and `status` before calling
`hercules.iam.tenants.auditEvents.list`.

## Resource Access

SDK request subjects are typed:

```ts
{ type: "user", user_id: userId }
{ type: "group", group_id: groupId }
```

Use additive resource roles for normal per-resource access. Use permission
overrides only for exceptional allow/deny behavior.

```ts
await hercules.iam.tenants.resources.grants.create(String(documentId), {
  tenant_id: tenantId,
  resource_type: "app.documents",
  subject: { type: "user", user_id: userId },
  role: { key: "reviewer" },
  applies_to: "self",
  user_token_identifier: identity.tokenIdentifier,
});
```

Use `hercules.iam.tenants.resources.accessGrantingRoles` for the exact resource
picker and `hercules.iam.tenants.resources.grants.update` for an atomic
complete editor save. Use `hercules.iam.tenants.grants.update` to set or clear
`expires_at` and `hercules.iam.tenants.grants.delete` to revoke any role,
permission, or resource grant by grant ID. Pass `null` to make a grant
non-expiring.

## Product Tenants

Create product tenants from an `authenticatedAction` and direct SDK call:

```ts
export const createTenant = authenticatedAction({
  args: {
    name: v.string(),
    accessMode: v.optional(v.string()),
    defaultRole: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.tokenIdentifier) throw new Error("Authentication required");

    return await hercules.iam.tenants.create({
      name: args.name,
      access_mode: args.accessMode,
      default_role: args.defaultRole,
      user_token_identifier: identity.tokenIdentifier,
    });
  },
});
```

The creator becomes Owner automatically. Do not add a second signup role.
Create an app tenant metadata row only when the product needs extra fields.
Store the returned `tenant_id`.

## Resource Creator Bootstrap

`createResourceCreatorBootstrapAction` grants one fixed initial resource role
to the trusted creator of a provisioning row.

- The browser passes only `resourceId`.
- Trusted app data supplies `tenantId` and creator user id.
- Resource type, role, and descendant behavior are fixed in code.
- The creator must have active default app access and active target tenant
  access; the target tenant lifecycle must also be active.
- An active row is never bootstrapped again.

```ts
import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
import { components, internal } from "./_generated/api";
import { authenticatedAction } from "./iam";

export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
  authenticatedAction,
  resourceType: "app.projects",
  managerRole: { key: "project_manager" },
  appliesTo: "self_and_descendants",
  getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
  listMyTenants: components.hercules.queries.listMyTenants,
  getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
  activateResource: internal.projects.activateCreatorBootstrap,
});
```

The four query and mutation options are generated `FunctionReference` values.
The helper performs the `runQuery` and `runMutation` calls. Define
`getCreatorBootstrapTarget` as an internal query that accepts
`{ resourceId: string }` and returns
`{ tenantId, resourceId, creatorHerculesAuthUserId, state } | null`. Define
`activateCreatorBootstrap` as an internal mutation that accepts
`{ resourceId, creatorHerculesAuthUserId, grant }` and returns `null`.

## Static Checker

Run:

```bash
hercules-convex-iam-check convex
```

The checker catches deterministic source patterns such as raw exported Convex
builders, optional tenant ids on tenant-owned rows, caller-supplied tenant ids
for existing-row operations, and public paths to trusted service authority.

It does not prove runtime role decisions, row filtering, or control-plane writes
are authorized.

## Operational Notes

- Mirror reads may briefly lag a successful SDK write.
- Treat a not-yet-synchronized mirror state as loading, not as proof of
  authorization.
- `HERCULES_API_KEY` remains the server-side service credential name.
