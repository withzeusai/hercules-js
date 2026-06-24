# @usehercules/convex

Convex integration for Hercules managed IAM. The public model uses one term:
**tenant**. The default app tenant and additional product tenants use the same
APIs.

The package has three public entry points:

- `@usehercules/convex`: authorization builders and mirrored reads.
- `@usehercules/convex/iam-management`: signed-in user management actions.
- `@usehercules/convex/iam-service`: trusted internal automation.

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
  getDeploymentEntryStatus,
  getEffectivePermissions,
  listMyTenants,
  listMyRoles,
  getTenant,
  listTenantUsers,
  listTenantGroups,
  listTenantUserDirectory,
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

Keep this as the main IAM wiring file. Add `convex/iamManagement.ts` only when
the app needs user-initiated management actions. Add `convex/iamService.ts`
only for explicit trusted internal automation.

IAM actions use Convex's default runtime. Do not add `"use node"`.

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
- Permission checks do not filter database rows. Queries must still select
  rows belonging to the requested tenant and resource.
- Do not infer authorization from role names or `listMyRoles`.

## Authorization

`iamQuery`, `iamMutation`, and `iamAction` require a `permission`. Their
optional `tenant` extractor defaults to the app's default tenant.

| Operation    | Default tenant                         | Explicit tenant                 |
| ------------ | -------------------------------------- | ------------------------------- |
| Create/list  | omit `tenant`                          | `tenantFromArg("tenantId")`     |
| Existing row | `tenantFromDefaultResource(...)`       | `tenantFromResource(...)`       |
| Child create | `tenantFromDefaultParentResource(...)` | `tenantFromParentResource(...)` |

For an existing row, derive the tenant from the loaded row. Do not accept both
a row id and a browser-supplied tenant id.

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

`filterAuthorizedResources` filters a bounded page of app-owned rows by
running a resource check for each row. It does not load or paginate app data.

## Mirrored Reads

Reads come from the local Convex mirror:

- `listMyTenants(ctx, { cursor, limit })`
- `listMyRoles(ctx, { tenantId })`
- `getEffectivePermissions(ctx, { tenantId, resource })`
- `getTenant(ctx, { tenantId })`
- `listTenantUsers(ctx, { tenantId, cursor, limit })`
- `listTenantGroups(ctx, { tenantId, cursor, limit })`
- `listTenantUserDirectory(ctx, { tenantId, cursor, limit })`
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

`listMyTenants` returns `{ tenants, nextCursor? }`. `listTenantUsers` returns
`{ users, nextCursor? }`. `listTenantGroups` returns
`{ groups, nextCursor? }`. Each page contains at most 100 records. Both include
`directRoleGrants` with the full role grant shape and nullable expiry for each
direct tenant role assignment. Effective `roles` may also include roles
inherited through groups. `listTenantGroups` also includes the current direct
`memberCount`.
`listGroupMembers` returns `{ users, nextCursor? }`, `listUserGroups` returns
`{ groups, nextCursor? }`, and `listDirectSubjectsForResource` returns
`{ subjects, nextCursor? }`. These reads also cap pages at 100 records.
`getTenantRole` includes the description, base permissions, tenant overrides,
and effective permissions.
`listDirectSubjectsForResource` keeps each user or group as the containing
subject and exposes its direct role or permission grant under `grant`.
It requires `system.access.grants:read` in the tenant.
`getResourcePermissionOverrides` returns the mirrored direct permission grants
for one user, group, or role target.
`explainAccess` requires `system.access.grants:read` and explains the same
evaluator used by `hasPermission` and the IAM builders.

Select the default app tenant by `kind`, not array order:

```ts
const { tenants } = await listMyTenants(ctx, { limit: 100 });
const tenant = tenants.find(({ kind }) => kind === "default");
if (!tenant) throw new Error("Default IAM tenant not found");
```

`listTenantRoles` is the complete mirrored role catalog. Use
`evaluateGrantableRoles` for a write picker because it returns only roles the
current actor may grant at the exact target.

## Role References

Every role reference is exactly one of:

```ts
{
  id: "role_123";
}
{
  key: "reviewer";
}
```

Do not pass both fields. Do not pass optional `roleId` and `roleKey`
properties.

## User Management

Create signed-in management actions in `convex/iamManagement.ts`:

```ts
import { createIamManagementActions } from "@usehercules/convex/iam-management";
import { authenticatedAction } from "./iam";

export const {
  createUser,
  updateUser,
  removeUser,
  replaceUserRoles,
  listUserPermissionOverrides,
  replaceUserPermissionOverrides,
} = createIamManagementActions({ authenticatedAction });
```

These are Convex actions. Frontend code calls them with `useAction`. Each
management call requires the signed-in user's OIDC `idToken`. Keep controls
disabled until the token exists.
`listUserPermissionOverrides` returns the user's full direct permission grant
objects, including grant IDs and nullable expiry.

```ts
await createUser({
  tenantId,
  userId,
  grant: {
    role: { key: "member" },
    expiresAt: null,
  },
  idToken,
});

await replaceUserRoles({
  tenantId,
  userId,
  grants: [
    {
      role: { key: "reviewer" },
      expiresAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  idToken,
});
```

## Groups

The management and service factories expose:

- `createGroup`
- `updateGroup`
- `archiveGroup`
- `addGroupMember`
- `removeGroupMember`
- `replaceGroupRoles`
- `listGroupPermissionOverrides`
- `replaceGroupPermissionOverrides`

```ts
await updateGroup({
  tenantId,
  groupId,
  action: "suspend",
  idToken,
});

await addGroupMember({
  tenantId,
  groupId,
  userId,
  idToken,
});
```

## Roles And Overrides

The factories expose:

- `createRole`
- `updateRole`
- `archiveRole`
- `evaluateGrantableRoles`
- `listRolePermissionOverrides`
- `replaceRolePermissionOverrides`

Use permission overrides for explicit allow/deny exceptions. Normal tenant
access should come from roles. User permission override grants may include
`expiresAt`. Role permission overrides modify the role definition and do not
accept an expiry.

## Admission Rules

The factories expose:

- `listAdmissionRules`
- `createAdmissionRule`
- `updateAdmissionRule`
- `archiveAdmissionRule`

Admission rules control who may enter a tenant. They do not replace
authorization checks inside app functions.

## Audit Events

Use `listAuditEvents` for cursor-paginated IAM audit history. Audit events are
REST reads and are not projected into the Convex mirror.

## Invitations

The factories expose:

- `listInvitations`
- `createInvitation`
- `revokeInvitation`

One invitation API handles tenant and resource targets:

```ts
await createInvitation({
  tenantId,
  email,
  target: { type: "tenant" },
  grants: [{ role: { key: "member" }, expiresAt: null }],
  idToken,
});

await createInvitation({
  tenantId,
  email,
  target: {
    type: "resource",
    resourceType: "app.documents",
    resourceId: String(documentId),
    appliesTo: "self",
  },
  grant: {
    role: { key: "reviewer" },
    expiresAt: "2026-07-01T00:00:00.000Z",
  },
  idToken,
});

// A resource invitation may instead confer one direct permission.
await createInvitation({
  tenantId,
  email,
  target: {
    type: "resource",
    resourceType: "app.documents",
    resourceId: String(documentId),
    appliesTo: "self",
  },
  grant: { permissionKey: "app.documents:read", expiresAt: null },
  idToken,
});
```

Use `acceptIamInvitation` from app-owned authenticated code. The invitee is
identified by the invitation token and signed-in `idToken`.
`listInvitations` accepts `cursor`, `limit`, `email`, `targetType`,
`resourceType`, and `resourceId`. Pass `resourceType` and `resourceId`
together. The result includes `nextCursor` when another page exists.

## Resource Access

The factories expose:

- `createResourceGrant`
- `replaceResourceGrants`
- `replaceResourcePermissionOverrides`

Use `updateGrant` to set or clear expiry and `deleteGrant` to revoke any role
assignment, user permission override, or resource grant by grant ID. Pass
`null` to make a grant non-expiring.

Subjects are typed:

```ts
{
  type: ("user", userId);
}
{
  type: ("group", groupId);
}
```

Role references remain `{ id }` or `{ key }`.

```ts
await createResourceGrant({
  tenantId,
  resourceType: "app.documents",
  resourceId: String(documentId),
  subject: { type: "user", userId },
  role: { key: "reviewer" },
  appliesTo: "self",
  idToken,
});
```

Use `replaceResourceGrants` for an atomic complete replacement. Use
`replaceResourcePermissionOverrides` only for ordinary allow/deny exceptions,
not to grant privileged management permissions. Resource permission overrides
may include `expiresAt`.

## Tenants And Entry

Use `createIamTenantAction` for app-controlled tenant creation:

```ts
import { createIamTenantAction } from "@usehercules/convex/iam-management";
import { authenticatedAction } from "./iam";

export const createTenant = createIamTenantAction({
  authenticatedAction,
  canCreateTenant: async (ctx, args) => {
    // App product-policy check.
    return true;
  },
});
```

The creator becomes Owner automatically. Do not add a second signup role.

`updateTenant` accepts `name`, `entryMode`, and `defaultRole`. At least one
must be supplied:

```ts
await updateTenant({
  tenantId,
  defaultRole: { key: "member" },
  idToken,
});
```

Use `createDeploymentEntryAction` for the default app tenant. Use
`evaluateTenantEntry` for an explicit tenant. Entry evaluation is not a
replacement for backend permission checks.

## Resource Creator Bootstrap

`createResourceCreatorBootstrapAction` grants one fixed initial resource role
to the trusted creator of a provisioning row.

- The browser passes only `resourceId`.
- Trusted app data supplies `tenantId` and creator user id.
- Resource type, role, and descendant behavior are fixed in code.
- The creator must be active in the tenant.
- An active row is never bootstrapped again.

```ts
export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
  authenticatedAction,
  resourceType: "app.projects",
  managerRole: { key: "project_manager" },
  appliesTo: "self_and_descendants",
  listMyTenants,
  getBootstrapTarget: async (ctx, { resourceId }) =>
    ctx.runQuery(internal.projects.getCreatorBootstrapTarget, {
      projectId: resourceId as Id<"projects">,
    }),
  activateResource: async (ctx, args) =>
    ctx.runMutation(internal.projects.activateCreatorBootstrap, args),
});
```

## Trusted Service Actions

Only trusted internal automation should use `iam-service`:

```ts
import { createIamServiceActions } from "@usehercules/convex/iam-service";
import { internalAction } from "./_generated/server";

export const { replaceUserRoles, createInvitation, createResourceGrant, archiveTenant } =
  createIamServiceActions({ internalAction });
```

Never call generated `internal.iamService.*` actions from an exported public,
authenticated, or IAM function, directly or through a helper.

The management and service factories share the same resource actions. The
management factory additionally exposes `evaluateTenantEntry`; the service
factory additionally exposes `archiveTenant`.

## Static Checker

Run:

```bash
hercules-convex-iam-check convex
```

The checker catches deterministic source patterns such as raw exported Convex
builders, optional tenant ids on tenant-owned rows, caller-supplied tenant ids
for existing-row operations, and public paths to service authority.

It does not prove runtime role decisions, row filtering, or control-plane
writes are authorized.

## Operational Notes

- Mirror reads may briefly lag a successful management write.
- Treat a not-yet-synchronized mirror state as loading, not as proof of
  authorization.
- `HERCULES_API_KEY` remains the service credential name.
