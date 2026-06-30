# @usehercules/convex

Convex integration for Hercules-managed IAM. This file is the authoritative,
agent-readable contract: every exported helper is documented below with its
input parameters and output shape. Do not grep `node_modules` `.d.ts` files;
read this. Do not infer public behavior from component implementation files.

The public model uses one term: **tenant**. The root app tenant and additional
product tenants use the same APIs.

Use this package for authorization builders, mirrored reads, the IAM error
classifier, the sync webhook route, and the fixed creator-bootstrap helper. Use
the generated `@usehercules/sdk` client directly from Convex actions for IAM
writes and REST reads.

## Package entry points

```ts
import { createIam, classifyIamError /* …types, extractors */ } from "@usehercules/convex";
import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
import { registerIamRoutes } from "@usehercules/convex/http";
import herculesComponent from "@usehercules/convex/convex.config"; // defineComponent("hercules")
```

| Export path                         | Provides                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `@usehercules/convex`               | `createIam`, authorization extractors, `classifyIamError`, types |
| `@usehercules/convex/iam-helpers`   | `createResourceCreatorBootstrapAction`                           |
| `@usehercules/convex/http`          | `registerIamRoutes`                                              |
| `@usehercules/convex/convex.config` | the `hercules` Convex component definition                       |
| `hercules-convex-iam-check` (bin)   | static source checker (`hercules-convex-iam-check convex`)       |

---

## User identity model

There is ONE user identifier across IAM. Internalize this before using any
helper; it is the single most confusing point.

- The Hercules Auth user id = the OIDC `sub` = `identity.subject` from
  `ctx.auth.getUserIdentity()`. These three are the same string.
- `getCurrentUserId(ctx)` returns it for the signed-in user.
- Every mirrored read exposes it as `userId` on each user (e.g.
  `listTenantUsers(ctx).users[].userId`). The SDK takes the same value as
  `user_id` (snake_case) on writes such as
  `hercules.iam.tenants.users.update(userId, …)`. `userId` (helpers, camelCase)
  and `user_id` (SDK, snake_case) are the SAME value.
- `actor_token_identifier` is DIFFERENT. It is the full
  `identity.tokenIdentifier` (`issuer|sub`), used ONLY as the authority field on
  SDK writes. Never use it as a lookup id.
- The server derives both `subject` and `tokenIdentifier` from
  `ctx.auth.getUserIdentity()`. The browser never sends either. Never accept
  `actor_token_identifier` or a token identifier from action args.

To link app-owned profile or domain rows to the signed-in user, store
`getCurrentUserId(ctx)`. Do not parse `tokenIdentifier`.

---

## Setup

Register the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import hercules from "@usehercules/convex/convex.config";

const app = defineApp();
app.use(hercules);
export default app;
```

Wire IAM once in `convex/iam.ts`, then re-export the builders:

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
  getCurrentUserId,
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
  rootTenant,
  tenantArg,
  rootParentResource,
  rootResource,
  parentResource,
  resource,
} from "@usehercules/convex";
```

Keep this as the main IAM wiring file. Add app-owned Convex action modules only
when the app needs IAM writes. IAM actions use Convex's default runtime. Do not
add `"use node"`.

### `createIam(options)`

Wires Hercules managed IAM into a Convex app. Call once.

Parameters (`CreateIamOptions<DataModel>`):

| Field           | Type                                | Req | Meaning                                             |
| --------------- | ----------------------------------- | --- | --------------------------------------------------- |
| `query`         | `QueryBuilder<DataModel, "public">` | yes | The generated `query` builder.                      |
| `mutation`      | `MutationBuilder<…, "public">`      | yes | The generated `mutation` builder.                   |
| `action`        | `ActionBuilder<…, "public">`        | yes | The generated `action` builder.                     |
| `components`    | `Record<string, unknown>`           | no  | The generated `components`; resolves the component. |
| `component`     | `IamComponent`                      | no  | Explicit component, bypasses `components` lookup.   |
| `componentName` | `string`                            | no  | Component name to look up (default `"hercules"`).   |

Returns `IamBuilders<DataModel>`: the function builders, in-handler helpers, and
mirrored reads documented below. Throws if the component cannot be resolved.

---

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

- Runtime permission checks use concrete keys such as `app.documents:update`.
  Do not check `manage` or `*`.
- Permission checks do not filter database rows. Queries must still select rows
  belonging to the requested tenant and resource.
- Do not infer authorization from role names or `listMyRoles`.

---

## Authorization

`iamQuery`, `iamMutation`, and `iamAction` require a `permission`. Their optional
`authorizeAgainst` extractor resolves to the app's root tenant when omitted.

For the root tenant, omit `tenantId` from Convex IAM permission and mirror
helpers where it is optional. Never pass `tenantId: "root"` to a Convex IAM
helper. If a helper requires a specific target tenant, pass its persisted
canonical ID. The public `"root"` sentinel is only for generated SDK/REST
management methods that require a tenant identifier.

| Operation    | Root tenant               | Explicit tenant         |
| ------------ | ------------------------- | ----------------------- |
| Create/list  | omit `authorizeAgainst`   | `tenantArg("tenantId")` |
| Existing row | `rootResource(...)`       | `resource(...)`         |
| Child create | `rootParentResource(...)` | `parentResource(...)`   |

For an existing row, derive the tenant from the loaded row. Do not accept both a
row id and a browser-supplied tenant id. The target and ancestors are evaluated
atomically; any applicable deny wins. The ancestor chain is bounded to ten.

```ts
import { v } from "convex/values";
import { iamMutation, iamQuery, tenantArg, resource } from "./iam";

export const listProjects = iamQuery({
  permission: "app.projects:read",
  authorizeAgainst: tenantArg("tenantId"),
  args: { tenantId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("projects")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .collect(),
});

export const archiveProject = iamMutation({
  permission: "app.projects:archive",
  authorizeAgainst: resource("projects", "projectId"),
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => ctx.db.patch(args.projectId, { status: "archived" }),
});
```

---

## API Reference: function builders

All builders are returned from `createIam`. Each wraps a Convex
`query`/`mutation`/`action` and accepts the standard Convex definition object
(`{ args?, returns?, handler }`).

### `publicQuery` / `publicMutation` / `publicAction`

The unwrapped generated builders. No authentication. Use for truly public
endpoints.

### `authenticatedQuery` / `authenticatedMutation` / `authenticatedAction`

Require a signed-in user only (no permission). The wrapper throws
`ConvexError { code: "UNAUTHENTICATED", reasonCode: "missing_identity" }` when
`identity.tokenIdentifier` is absent.

### `iamQuery` / `iamMutation` / `iamAction`

Enforce a permission in a tenant before running the handler. Definition object
adds two fields to the standard Convex definition:

| Field              | Type                            | Req | Meaning                                                     |
| ------------------ | ------------------------------- | --- | ----------------------------------------------------------- |
| `permission`       | `string`                        | yes | Concrete catalog permission key (e.g. `app.projects:read`). |
| `authorizeAgainst` | `ExtractTenant<Ctx, Args>`      | no  | Resolves the tenant/resource. Defaults to `rootTenant`.     |
| `args`             | validator                       | no  | Standard Convex args validator.                             |
| `returns`          | validator                       | no  | Standard Convex returns validator.                          |
| `handler`          | `(ctx, ...args) => ReturnValue` | yes | Runs only after authorization passes.                       |

On denial throws `ConvexError { code: "ACCESS_DENIED", reasonCode, sourceVersion? }`.
On missing identity throws the same with `reasonCode: "missing_identity"`.

---

## API Reference: authorization extractors

An extractor is `(ctx, args) => ExtractedTenant | Promise<ExtractedTenant>`,
where `ExtractedTenant` is either a tenant-id `string` or
`{ tenantId, resourceType?, resourceId?, ancestors? }`. Pass one as the `authorizeAgainst`
field of an `iam*` builder.

### `rootTenant`

`ExtractTenant` that always returns the root-tenant sentinel. The default when
`authorizeAgainst` is omitted. No resource binding.

### `tenantArg(argKey)`

Reads the tenant id from a string arg the caller supplies. Use for list/create
handlers where the frontend already knows the tenant.

- `argKey: K` (required) - the field on `args` holding the tenant id.
- Returns `(ctx, args) => string`. Throws `ConvexError { code: "INVALID_TENANT_ARG" }`
  if the arg is missing or empty.

### `resource(tableName, argKey, options?)`

Loads `args[argKey]` via `ctx.db.get`, reads the tenant from the row, and binds
authorization to that specific resource. Use for operations on an existing
tenant-owned row.

- `tableName: T` (required) - the row's table; used in error messages only.
- `argKey: K` (required) - the `args` field holding the row id.
- `options.tenantField?: string` - column carrying the tenant id (default `"tenantId"`).
- `options.ancestors?: (row) => IamAuthorizationAncestor[]` - ordered trusted parent resources.
- Returns `(ctx, args) => Promise<{ tenantId, resourceType, resourceId, ancestors? }>`.
  `resourceType` is a sentinel resolved to the permission's canonical catalog
  type. Throws `INVALID_TENANT_ARG`, `RESOURCE_NOT_FOUND`, or
  `INVALID_RESOURCE_TENANT`.

### `rootResource(tableName, argKey, options?)`

Like `resource` but binds to the root tenant without requiring a
tenant-id column on the row. Use for single-tenant apps needing resource grants,
denies, or per-resource UI checks.

- `tableName`, `argKey` (required) - as above.
- `options.ancestors?` - as above.
- Returns `(ctx, args) => Promise<{ tenantId, resourceType, resourceId, ancestors? }>`
  with `tenantId` set to the root sentinel.

### `parentResource(tableName, argKey, options)`

Resolves child-creation authorization from an existing parent row. The requested
child permission is unchanged; the parent is supplied as an explicit ancestor so
only descendant-enabled bindings apply through it.

- `tableName`, `argKey` (required).
- `options.parentResourceType: string` (required) - canonical type of the parent resource.
- `options.tenantField?: string` (default `"tenantId"`).
- `options.ancestors?` - additional trusted ancestors after the parent.
- Returns `(ctx, args) => Promise<{ tenantId, resourceType, ancestors }>`.

### `rootParentResource(tableName, argKey, options)`

Like `parentResource` but in the root tenant; no tenant-id field
required on parent or child.

- `tableName`, `argKey`, `options.parentResourceType` (required), `options.ancestors?`.
- Returns `(ctx, args) => Promise<{ tenantId, resourceType, ancestors }>` with the
  root sentinel.

```ts
authorizeAgainst: resource("tasks", "taskId", {
  ancestors: (task) => [{ type: "app.projects", id: String(task.projectId) }],
}),
```

---

## API Reference: in-handler permission helpers

Each takes an `IamContext` (any query/mutation/action ctx with `auth` and
`runQuery`). Helpers return a falsy/empty value when no identity is present
rather than throwing, except `requirePermission`/`requireAnyPermission`.

Shared argument shapes:

```ts
type PermissionCheckArgs =
  | string // permission key, root tenant
  | {
      tenantId?: string;
      permission: string;
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
    };

type AnyPermissionCheckArgs =
  | string[] // permission keys, root tenant
  | {
      tenantId?: string;
      permissions: string[];
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
    };

type EffectivePermissionsArgs = {
  tenantId?: string;
  resource?: IamResourceRef;
  ancestors?: IamAuthorizationAncestor[];
};
type IamResourceRef = { type: string; id?: string };
type IamAuthorizationAncestor = { type: string; id: string };
```

### `hasPermission(ctx, args)`

- `args: PermissionCheckArgs` - permission to check, optionally resource-scoped.
- Returns `Promise<boolean>`. `false` when unauthenticated.

### `requirePermission(ctx, args)`

- `args: PermissionCheckArgs`.
- Returns `Promise<void>`. Throws `ConvexError { code: "ACCESS_DENIED" }` when denied.

### `requireAnyPermission(ctx, args)`

Passes if the caller holds at least one of the listed permissions.

- `args: AnyPermissionCheckArgs`.
- Returns `Promise<void>`. Throws `ConvexError { code: "ACCESS_DENIED" }` when none match.

### `getEffectivePermissions(ctx, args?)`

- `args?: EffectivePermissionsArgs` - tenant and optional resource scope.
- Returns `Promise<string[]>` - the caller's effective permission keys. `[]` when
  unauthenticated. Under the wildcard model this is a projection over the
  catalog; treat a non-`"none"` wildcard mode as future-inclusive.

### `checkPermissions(ctx, checks)`

Batched authorization via `authorizeMany`.

- `checks: Array<Exclude<PermissionCheckArgs, string>>` - at most 50; throws
  `INVALID_PERMISSION_CHECKS` otherwise.
- Returns `Promise<AuthorizationDecision[]>`, index-aligned with `checks`. When
  unauthenticated returns one `{ allowed: false, reasonCode: "missing_identity", effectiveRoleIds: [] }` per check.

### `getCurrentUserId(ctx)`

The current user's canonical Hercules Auth id (the OIDC `sub` =
`identity.subject`). Use it to link app-owned rows to the signed-in user. Do not
parse `tokenIdentifier`.

- Returns `Promise<string | undefined>` - `undefined` when unauthenticated.

### `getTenantAccessStatus(ctx)`

The signed-in user's access status in the root app tenant.

- Returns `Promise<IamTenantAccessStatusResult>` (see Types). Returns
  `{ kind: "fallback", reason: "identity_missing" }` when unauthenticated.

### `filterAuthorizedResources(ctx, args)`

Filters a bounded page of the app's own rows down to those the caller may access,
running the same per-resource check as a real `iamQuery` (batched via
`authorizeMany` in chunks of 50). It does not load or paginate app data.

Parameters:

| Field        | Type                                      | Req | Meaning                                         |
| ------------ | ----------------------------------------- | --- | ----------------------------------------------- |
| `resources`  | `T[]`                                     | yes | A single bounded page of app rows, not a table. |
| `permission` | `string`                                  | yes | Permission checked per row.                     |
| `tenantId`   | `string`                                  | no  | Defaults to the root tenant.                    |
| `resource`   | `(item: T) => IamResourceRef`             | yes | Maps a row to its resource ref.                 |
| `ancestors`  | `(item: T) => IamAuthorizationAncestor[]` | no  | Maps a row to trusted ancestors.                |

- Returns `Promise<T[]>` - the input rows the caller is allowed to access (order
  preserved). `[]` when unauthenticated.

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
complete list, and do not loop unbounded to fill an authorized page.

---

## API Reference: mirrored reads

All reads resolve against the app's local IAM mirror, which lags the control
plane by a short projection-sync window after any change. Treat a
not-yet-synchronized state as loading, not as proof of authorization. Do not use
mirror reads as write authorization.

Every mirrored read takes an `IamContext` plus the args below. Each returns its
empty value (empty array, `null`, or `{ items: [] }`) when unauthenticated.
Admin reads self-gate on the matching `system.*:read` permission and return the
empty value when the caller lacks it. For the root tenant omit `tenantId`; it
defaults to the root sentinel. Paginated reads cap pages at 100 records and
return `nextCursor?` (present only when more pages exist).

User and group reads are separate. Tenant user APIs use `user`; group APIs use
`member`.

### `getTenantAccessStatus(ctx)`

See in-handler helpers above. Returns `IamTenantAccessStatusResult`.

### `listMyTenants(ctx, args?)`

The caller's tenant memberships, including an archived tenant only for a retained
active direct built-in Owner.

- `args?: { cursor?: string; limit?: number }`.
- Returns `TenantSummariesPage` = `{ tenants: TenantSummary[]; nextCursor? }`.

Select the root tenant by `isRoot`, not array order:

```ts
const { tenants } = await listMyTenants(ctx, { limit: 100 });
const tenant = tenants.find(({ isRoot }) => isRoot);
if (!tenant) throw new Error("Root IAM tenant not found");
```

### `listMyActiveTenants(ctx, args?)`

Only active memberships in active tenants; narrows both statuses to `"active"`.
Requires active standing in the root app tenant; returns an empty page when root
standing is inactive.

- `args?: { cursor?: string; limit?: number; isRoot?: boolean }` - pass `isRoot`
  to filter to or away from the root tenant without assuming order.
- Returns `ActiveTenantSummariesPage` = `{ tenants: ActiveTenantSummary[]; nextCursor? }`.

### `getTargetTenantSyncStatus(ctx, args)`

Whether the local mirror has caught up to a specific control-plane write.

- `args: { tenantId: string; sourceVersion: number }` - pass
  `response.convex_source_data.version` from the SDK write as `sourceVersion`.
- Returns `TargetTenantSyncStatus` (see Types): `syncing` | `ready` | `denied` | `failed`.

```ts
const sourceVersion = response.convex_source_data.version;
await getTargetTenantSyncStatus(ctx, { tenantId, sourceVersion });
```

`syncing`: mirror has not reached the write. `ready`: target tenant, target
principal, and root standing are active after the barrier. `denied`: completed
access denial after the barrier. `failed`: identity, issuer, mirror, or target
tenant invalid after the promised version. Do not treat missing target mirror
data before the barrier as denial.

### `listMyRoles(ctx, args?)`

The caller's roles in a tenant. Display only; do not infer authorization.

- `args?: { tenantId?: string }`.
- Returns `RoleSummary[]`.

### `getTenant(ctx, args?)`

- `args?: { tenantId?: string }`.
- Returns `TenantDetail | null`.

### `listTenantUsers(ctx, args?)`

Gated on `system.access.users:read`.

- `args?: { tenantId?: string; cursor?: string; limit?: number }`.
- Returns `TenantUsersPage` = `{ users: TenantUser[]; nextCursor? }`. Effective
  `roles` may include roles inherited through groups; `directRoleGrants` carries
  the full role grant shape with nullable expiry.

### `listTenantGroups(ctx, args?)`

Gated on `system.access.users:read`.

- `args?: { tenantId?: string; cursor?: string; limit?: number }`.
- Returns `TenantGroupsPage` = `{ groups: TenantGroup[]; nextCursor? }`. Each
  group includes the current direct `memberCount`.

### `listTenantUserDirectory(ctx, args?)`

Directory view for member screens.

- `args?: { tenantId?: string; cursor?: string; limit?: number }`.
- Returns `TenantUserDirectoryPage` = `{ users: TenantUserDirectoryEntry[]; nextCursor? }`.

### `listTenantMemberPickerUsers(ctx, args)`

Least-privilege picker (e.g. task assignment). The trusted server call site
supplies the concrete app permission for the operation. Returns only active
users with picker-safe fields.

- `args: { tenantId?: string; permission: string; resource?: IamResourceRef; ancestors?: IamAuthorizationAncestor[]; cursor?: string; limit?: number }`.
  Pass `resource`/`ancestors` for resource-scoped operations; omit for
  tenant-level.
- Returns `TenantMemberPickerUsersPage` = `{ users: TenantMemberPickerUser[]; nextCursor? }`.

### `listResourceSharingRecipients(ctx, args)`

Exact-resource sharing picker. Supply the concrete resource permission whose
action is exactly `manage_members`, the exact resource, and one recipient type.
Returns an empty page when unauthenticated, unauthorized, or the permission
resolves to any other resource type or action.

- `args: { tenantId?: string; permission: string; resourceType: string; resourceId: string; ancestors?: IamAuthorizationAncestor[]; recipientType: "user" | "group"; cursor?: string; limit?: number }`.
- Returns `SharingRecipientsPage` = `{ recipients: SharingRecipient[]; nextCursor? }`.

### `getTenantUserDirectoryEntry(ctx, args)`

- `args: { tenantId?: string; userId: string }`.
- Returns `TenantUserDirectoryEntry | null`.

### `listGroupMembers(ctx, args)`

- `args: { tenantId?: string; groupId: string; cursor?: string; limit?: number }`.
- Returns `TenantUsersPage` = `{ users: TenantUser[]; nextCursor? }`.

### `listUserGroups(ctx, args)`

- `args: { tenantId?: string; userId: string; cursor?: string; limit?: number }`.
- Returns `TenantGroupsPage` = `{ groups: TenantGroup[]; nextCursor? }`.

### `listTenantRoles(ctx, args?)`

The complete mirrored role catalog. Back tenant assignment pickers with
`hercules.iam.tenants.grantableRoles` and exact resource pickers with
`hercules.iam.tenants.resources.accessGrantingRoles`.

- `args?: { tenantId?: string }`.
- Returns `TenantRoleSummary[]`.

### `getTenantRole(ctx, args)`

- `args: { tenantId?: string; roleId: string }`.
- Returns `TenantRoleDetail | null` - includes description, base permissions,
  tenant overrides, and effective permissions.

### `listTenantPermissions(ctx, args?)`

- `args?: { tenantId?: string }`.
- Returns `TenantPermissionSummary[]`.

### `getResourcePermissionOverrides(ctx, args)`

- `args: { tenantId?: string; subject: ResourcePermissionOverrideSubject; resourceType: string; target: ResourcePermissionOverrideTarget }`.
- Returns `ResourcePermissionOverridesResult | null`.

### `explainAccess(ctx, args)`

Full decision trace for a subject, permission, and target. For debugging and
access-explanation UI.

- `args: { tenantId?: string; userId: string; permission: string; target: ExplainAccessTarget }`.
- Returns `ExplainAccessResult | null`.

### `listDirectSubjectsForResource(ctx, args)`

Subjects holding a DIRECT grant on a resource (excludes tenant-wide
role/wildcard and parent-inherited access). Gated on
`system.access.grants:read`.

- `args: { tenantId?: string; resourceType: string; resourceId: string; cursor?: string; limit?: number }`.
- Returns `DirectResourceSubjectsPage` = `{ subjects: DirectResourceSubject[]; nextCursor? }`.

---

## Types

Exported from `@usehercules/convex`. These are the contract; one line per field.

### `RoleSummary`

```ts
type RoleSummary = {
  roleId: string; // canonical role id
  roleKey: string; // catalog key, display/reference only
  roleName: string; // display name
  roleKind: "system" | "custom";
};
```

### `TenantDirectRoleGrant`

```ts
type TenantDirectRoleGrant = RoleSummary & {
  grantId: string; // grant id, for SDK update/delete
  type: "role";
  expiresAt: number | null; // epoch ms, or null when non-expiring
};
```

### `TenantSummary` / `ActiveTenantSummary`

```ts
type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isRoot: boolean; // true for the root app tenant; select by this
  roles: RoleSummary[]; // the caller's effective roles in this tenant
  joinedAt: number; // epoch ms
  accessStatus: "active" | "blocked" | "suspended" | "pending_approval" | "removed"; // the caller's principal
  lifecycleStatus: "active" | "archived"; // the tenant itself
};
// ActiveTenantSummary narrows accessStatus and lifecycleStatus to "active".
```

### `TargetTenantSyncStatus`

```ts
type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      principalId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      principalId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };
```

### `TenantDetail`

```ts
type TenantDetail = {
  tenantId: string;
  tenantName: string;
  isRoot: boolean;
  lifecycleStatus: "active" | "archived";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string; // role new members receive
  updatedAt: number; // epoch ms
};
```

### `IamTenantAccessStatusResult`

```ts
type IamPrincipalStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

type IamTenantAccessStatusResult =
  | { kind: "principal"; principalId: string; status: IamPrincipalStatus; stateVersion: number }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "root_tenant_missing"
        | "principal_missing";
      stateVersion?: number;
    };
```

### `EffectivePermissionsResult`

Returned by the component query; `getEffectivePermissions` returns just
`.permissions`.

```ts
type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  tenantId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  wildcard: "none" | "immutable" | "default"; // non-"none" is future-inclusive over the catalog
  permissions: string[];
};
```

### `TenantUser` / `TenantGroup`

```ts
type TenantUser = {
  userId: string; // Hercules Auth user id (= SDK user_id)
  status: IamPrincipalStatus;
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[]; // effective, may include via-group
  directRoleGrants: TenantDirectRoleGrant[]; // direct grants only
};

type TenantGroup = {
  groupId: string;
  status: IamPrincipalStatus;
  joinedAt: number;
  memberCount: number; // current direct members
  name?: string;
  roles: RoleSummary[];
  directRoleGrants: TenantDirectRoleGrant[];
};
```

### Directory and picker shapes

```ts
type TenantUserDirectoryEntry = {
  userId: string;
  name: string;
  email: string;
  image?: string;
  roles: RoleSummary[];
};
type TenantMemberPickerUser = { userId: string; name: string; email: string; image?: string };
type SharingRecipient =
  | { type: "user"; userId: string; name: string; email: string; image?: string }
  | { type: "group"; groupId: string; name?: string };
```

### Role and permission catalog shapes

```ts
type TenantRoleSummary = RoleSummary & { shared: boolean }; // shared across tenants

type TenantPermissionSummary = {
  permissionId: string;
  key: string; // e.g. app.documents:read
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean; // assignable by tenant admins
};

type TenantRolePermission = TenantPermissionSummary & { effect: "allow" | "deny" };

type TenantRoleDetail = TenantRoleSummary & {
  description: string | null;
  basePermissions: TenantRolePermission[]; // from catalog role
  tenantOverrides: TenantRolePermission[]; // tenant-level overrides
  effectivePermissions: TenantPermissionSummary[]; // net result
};
```

### Resource grant / override shapes

```ts
type DirectResourceRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourcePermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

// Discriminated by subject `type` and grant kind.
type DirectResourceSubject = {
  status: IamPrincipalStatus;
  name?: string;
  email?: string;
  image?: string;
} & ({ type: "user"; userId: string } | { type: "group"; groupId: string }) &
  (
    | { grant: DirectResourceRoleGrant; role: RoleSummary }
    | { grant: DirectResourcePermissionGrant }
  );

type ResourcePermissionOverrideSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };
type ResourcePermissionOverrideTarget = { type: "all" } | { type: "resource"; resourceId: string };

type ResourcePermissionOverridesResult = {
  tenantId: string;
  subject: ResourcePermissionOverrideSubject;
  resourceType: string;
  target: ResourcePermissionOverrideTarget;
  grants: DirectResourcePermissionGrant[];
};
```

### `ExplainAccessResult`

```ts
type ExplainAccessTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      ancestors?: Array<{ resourceType: string; resourceId: string }>;
    };

type ExplainAccessResult = {
  tenantId: string;
  userId: string;
  permission: string;
  target: ExplainAccessTarget;
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  decisiveReason: string; // the rule that decided the outcome
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
  sources: {
    // full evidence trace
    directGrants: ExplainAccessGrantSource[];
    groupMemberships: Array<{
      groupId: string;
      groupName?: string;
      status?: IamPrincipalStatus;
      active: boolean;
    }>;
    roles: Array<{
      roleId: string;
      roleKey: string;
      roleName: string;
      description: string | null;
      wildcard: "none" | "immutable" | "default";
      permissionEffect: "allow" | "deny" | null;
      grantIds: string[];
      viaGroupIds: string[];
    }>;
    roleOverrides: Array<{
      roleId: string;
      permissionId: string;
      permissionKey: string;
      effect: "allow" | "deny";
    }>;
    resourceGrants: ExplainAccessGrantSource[];
    ancestorGrants: ExplainAccessGrantSource[];
    explicitDenies: Array<{
      resourceType: string;
      action: string;
      objectType: "tenant" | "resource";
      objectId?: string;
      source?: ExplainAccessEntryOrigin;
    }>;
    expiredIgnoredGrants: ExplainAccessGrantSource[];
  };
};
```

### `AuthorizationDecision`

Returned by `checkPermissions`.

```ts
type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  explicitDeny?: boolean;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
};
```

### Page shapes

Every paginated read returns `{ <items>: T[]; nextCursor?: string }`:
`TenantSummariesPage` (`tenants`), `ActiveTenantSummariesPage` (`tenants`),
`TenantUsersPage` (`users`), `TenantGroupsPage` (`groups`),
`TenantUserDirectoryPage` (`users`), `TenantMemberPickerUsersPage` (`users`),
`SharingRecipientsPage` (`recipients`), `DirectResourceSubjectsPage`
(`subjects`). `nextCursor` is present only when another page exists; pass it back
as `cursor`.

---

## IAM Actions (SDK writes)

Create app-owned Convex actions for IAM writes and REST reads. Call the generated
SDK directly. SDK request and query fields use snake_case.

```ts
import { Hercules } from "@usehercules/sdk";
import { v } from "convex/values";
import { authenticatedAction } from "./iam";

const hercules = new Hercules({ apiKey: process.env.HERCULES_API_KEY! });

export const updateTenantUser = authenticatedAction({
  args: {
    tenantId: v.string(),
    userId: v.string(),
    roleGrants: v.array(v.object({ roleId: v.string(), expiresAt: v.union(v.string(), v.null()) })),
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
      actor_token_identifier: identity.tokenIdentifier,
    });
  },
});
```

For `authenticatedAction` and `iamAction` handlers:

1. Get `identity = await ctx.auth.getUserIdentity()`.
2. Require `identity?.tokenIdentifier`.
3. Pass `actor_token_identifier: identity.tokenIdentifier` in the SDK request.

Never accept `actor_token_identifier` from action args. Browser code uses
`useAction` and passes business args only. Map app-facing args to SDK fields such
as `tenant_id`, `resource_type`, `access_mode`, `default_role`, `applies_to`,
`expires_at`, and `actor_token_identifier`.

Pass the deepest path identifier as the positional argument; put ancestor path
fields in the request object. For example
`hercules.iam.tenants.users.update(userId, { tenant_id, ... })` takes `userId`
positionally, not `tenantId` and `userId` as two positionals.

Trusted `internalAction` service workflows use `actor_token_identifier: null` on
methods that permit service authority:

```ts
export const unarchiveTenantForBilling = internalAction({
  args: { tenantId: v.string() },
  handler: async (_, args) =>
    hercules.iam.tenants.unarchive(args.tenantId, { actor_token_identifier: null }),
});
```

### Public IAM SDK (source of truth)

- Tenants: `hercules.iam.tenants.create`, `.update`, `.list`, `.get`, `.archive`,
  `.unarchive`, `.createInvitation`, `.evaluateAccess`, `.grantableRoles`
- Users: `hercules.iam.tenants.users.create`, `.update`, `.remove`
- User permission overrides: `hercules.iam.tenants.users.permissionOverrides.get`, `.update`
- Tenant grants: `hercules.iam.tenants.grants.update`, `.delete`
- Groups: `hercules.iam.tenants.groups.create`, `.update`, `.archive`, `.unarchive`
- Group members: `hercules.iam.tenants.groups.members.add`, `.remove`
- Group permission overrides: `hercules.iam.tenants.groups.permissionOverrides.get`, `.update`
- Roles: `hercules.iam.tenants.roles.create`, `.update`, `.archive`, `.unarchive`
- Role permission overrides: `hercules.iam.tenants.roles.permissionOverrides.get`, `.update`
- Access rules: `hercules.iam.tenants.accessRules.list`, `.create`, `.update`, `.archive`, `.unarchive`
- Audit events: `hercules.iam.tenants.auditEvents.list`
- Tenant invitations: `hercules.iam.tenants.invitations.list`, `.revoke`
- Invitation acceptance: `hercules.iam.invitations.accept`
- Resource access: `hercules.iam.tenants.resources.accessGrantingRoles`, `.createInvitation`,
  `.grants.create`, `.grants.update`, `.permissionOverrides.update`

Role references are exactly `{ id }` or `{ key }`. Include `roles` in user
create/update and group update bodies for complete direct tenant role sets. Set
the user update `action` to `approve`, `suspend`, or `unsuspend` for lifecycle
changes. `hercules.iam.tenants.update` accepts `name`, `access_mode`, and
`default_role`. Access modes: `open`, `allowlisted_only`, `invite_only`,
`approval_required`.

Generated list operations use `starting_after` (not `cursor`) and return
`{ data, has_more }`. When `has_more`, pass the final record's ID as
`starting_after`. Tenant list/get records expose `lifecycle_status` and
`is_root`.

After any control-plane write, the SDK keeps `changed`, `version`, and
`projection_ids` under `convex_source_data`. Use `convex_source_data.version`
(not a top-level `source_version`) as the `sourceVersion` for
`getTargetTenantSyncStatus`.

---

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
  actor_token_identifier: identity.tokenIdentifier,
});
```

Use `hercules.iam.tenants.resources.accessGrantingRoles` for the exact resource
picker and `.grants.update` for an atomic complete editor save. Use
`hercules.iam.tenants.grants.update` to set or clear `expires_at` (pass `null`
for non-expiring) and `.grants.delete` to revoke any grant by grant ID.

---

## Resource Creator Bootstrap

`createResourceCreatorBootstrapAction` grants one fixed initial resource role to
the trusted creator of a provisioning row.

- The browser passes only `resourceId`.
- Trusted app data supplies `tenantId` and the creator user id.
- Resource type, role, and descendant behavior are fixed in code.
- The creator must have active root app access and active target tenant access;
  the target tenant lifecycle must also be active.
- An active row is never bootstrapped again.

Import from `@usehercules/convex/iam-helpers`.

### `createResourceCreatorBootstrapAction(options)`

Parameters (`CreateResourceCreatorBootstrapActionOptions<DataModel>`):

| Field                   | Type                                                                                          | Req | Meaning                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------- |
| `authenticatedAction`   | `ActionBuilder<DataModel, "public">`                                                          | yes | Your wrapped authenticated action builder.                           |
| `resourceType`          | `string`                                                                                      | yes | Canonical resource type for the grant (e.g. `app.projects`).         |
| `managerRole`           | `IamRoleReference` (`{ id }` or `{ key }`)                                                    | yes | Role granted to the creator.                                         |
| `appliesTo`             | `"self" \| "self_and_descendants"`                                                            | yes | Whether the grant covers descendants.                                |
| `getTenantAccessStatus` | `FunctionReference<"query","public",…>`                                                       | yes | Component query `components.hercules.queries.getTenantAccessStatus`. |
| `listMyTenants`         | `FunctionReference<"query","public",…>`                                                       | yes | Component query `components.hercules.queries.listMyTenants`.         |
| `getBootstrapTarget`    | `FunctionReference<"query","internal",{ resourceId },ResourceCreatorBootstrapTarget \| null>` | yes | App internal query resolving the target row.                         |
| `activateResource`      | `FunctionReference<"mutation","internal",ResourceCreatorBootstrapActivationArgs,null>`        | yes | App internal mutation marking the row active.                        |
| `apiKey`                | `string`                                                                                      | no  | Overrides the env-var API key.                                       |
| `apiKeyEnvVar`          | `string`                                                                                      | no  | Env var to read the key from (default `HERCULES_API_KEY`).           |
| `apiVersion`            | `string`                                                                                      | no  | SDK API version (default `2025-12-09`).                              |
| `client`                | `ResourceCreatorBootstrapClient`                                                              | no  | Inject a preconstructed SDK client (testing).                        |

Returns a registered `authenticatedAction` with `args: { resourceId: v.string() }`
whose handler returns `ResourceCreatorBootstrapResult`:

```ts
type ResourceCreatorBootstrapResult =
  | { resourceId: string; state: "active"; bootstrapped: false } // already active
  | { resourceId: string; state: "active"; bootstrapped: true; grant: IamResourceGrantWriteResult };
```

Your app must define two internal functions matching these shapes (note the
field is `creatorUserId`):

```ts
// internal query
type ResourceCreatorBootstrapTarget = {
  tenantId: string;
  resourceId: string;
  creatorUserId: string; // = the creator's Hercules Auth user id
  state: "provisioning" | "active";
};

// internal mutation args
type ResourceCreatorBootstrapActivationArgs = {
  resourceId: string;
  creatorUserId: string;
  grant: IamResourceGrantWriteResult;
};

type IamResourceGrantWriteResult = {
  tenantId: string;
  changed: boolean; // from convex_source_data.changed
  sourceVersion: number; // from convex_source_data.version
  projectionIds: string[]; // from convex_source_data.projection_ids
  grant: {
    grantId: string;
    type: "resource_role";
    roleId: string;
    expiresAt: string | null;
    appliesTo: "self" | "self_and_descendants";
  };
};
```

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

The helper performs the `runQuery`/`runMutation` calls itself. On any failed
gate it throws `ConvexError { code: "ACCESS_DENIED" }`; on missing identity,
`ConvexError { code: "UNAUTHENTICATED" }`.

---

## Error classification

### `classifyIamError(error)`

Classifies runtime IAM denials that an app can recover from or present to users.
Configuration and unknown failures return `null`.

- `error: unknown` - a caught error from a Convex helper or SDK call.
- Returns `IamErrorClassification | null`:

```ts
type IamAdmissionStatus = "pending_approval" | "blocked" | "suspended" | "removed" | "missing";

type IamErrorClassification =
  | { kind: "admission"; reasonCode: string; status: IamAdmissionStatus; sourceVersion?: number }
  | { kind: "permission"; reasonCode: "permission_denied"; sourceVersion?: number }
  | { kind: "temporary"; reasonCode: "mirror_not_ready"; sourceVersion?: number }
  | {
      kind: "access";
      code:
        | "access_denied"
        | "user_authority_required"
        | "service_authority_required"
        | "owner_authority_required";
      status?: number;
      details?: Record<string, unknown>;
    }
  | {
      kind: "synchronization";
      code: "source_version_conflict";
      status?: number;
      details?: Record<string, unknown>;
    }
  | {
      kind: "operation";
      code:
        | "invalid_request"
        | "resource_not_found"
        | "state_conflict"
        | "invalid_resource_role"
        | "invalid_resource_permission"
        | "invalid_lifecycle_transition"
        | "last_owner_required"
        | "grant_conflict";
      status?: number;
      details?: Record<string, unknown>;
    };
```

`admission`/`permission`/`temporary` come from local `ConvexError ACCESS_DENIED`
denials (reason codes such as `principal_pending_approval`, `permission_denied`,
`mirror_not_ready`). `access`/`synchronization`/`operation` come from SDK
problem responses. Treat `temporary`/`mirror_not_ready` as loading, not denial.

---

## Webhook routes

### `registerIamRoutes(http, options)`

Registers the projection-sync webhook route that the Hercules control plane posts
to. Verifies the standard-webhooks signature, validates the payload, applies it
via the component mutation, and maps outcomes to HTTP status codes (200
applied/duplicate, 409 recoverable conflict, 400 payload problem, 401 bad
signature, 500 missing secret).

Call in `convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { registerIamRoutes } from "@usehercules/convex/http";
import { httpAction } from "./_generated/server";

const http = httpRouter();
registerIamRoutes(http, { httpAction });
export default http;
```

Parameters (`RegisterIamRoutesOptions`):

| Field           | Type                      | Req | Meaning                                                              |
| --------------- | ------------------------- | --- | -------------------------------------------------------------------- |
| `httpAction`    | `HttpActionBuilder`       | yes | The generated `httpAction` builder.                                  |
| `components`    | `Record<string, unknown>` | no  | Generated components; resolves the sync component.                   |
| `component`     | `IamSyncComponent`        | no  | Explicit component, bypasses lookup.                                 |
| `componentName` | `string`                  | no  | Component name to look up (default `"hercules"`).                    |
| `path`          | `string`                  | no  | Route path (default `/_hercules/iam/sync`).                          |
| `envVarName`    | `string`                  | no  | Env var holding the webhook secret (default `HERCULES_SYNC_SECRET`). |

Returns `void`. Set `HERCULES_SYNC_SECRET` in the Convex deployment env.

---

## Static checker

```bash
hercules-convex-iam-check convex
```

Catches deterministic source patterns: raw exported Convex builders, optional
tenant ids on tenant-owned rows, caller-supplied tenant ids for existing-row
operations, and public paths to trusted service authority. It does not prove
runtime role decisions, row filtering, or control-plane writes are authorized.

---

## Operational notes

- Mirror reads may briefly lag a successful SDK write. Treat a
  not-yet-synchronized mirror state as loading, not as proof of authorization.
- `HERCULES_API_KEY` is the server-side service credential name;
  `HERCULES_SYNC_SECRET` verifies the sync webhook.
- IAM actions use Convex's default runtime. Do not add `"use node"`.
- Do not call `.collect()` on unbounded tables, do not treat a fixed limit as a
  complete list, and do not loop unbounded to fill an authorized page.
