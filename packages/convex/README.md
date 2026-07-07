# @usehercules/convex

Authoritative, agent-readable reference for Hercules-managed IAM. Every read,
authorization, and resource-node function is listed below with its shape. Read
this instead of grepping `node_modules` `.d.ts`.

The model is ReBAC and allow-only. Subjects (users and groups) are members of
**tenants**. Roles hold permissions. A subject gets a role either tenant-wide (a
role assignment) or on a resource node (a resource role assignment, which also
covers every descendant of that node). No deny, no wildcard, no override.

The app wires IAM once in `convex/iam.ts` (scaffolded). Import the permission
builders and the `access` object from there:

- `protectedQuery` / `protectedMutation` / `protectedAction` - permission-aware builders.
- `access` - everything else: deployment entry (`access.enter`), in-handler auth
  (`access.hasPermissions`, `access.requirePermissions`), resource nodes
  (`access.resource.*`), caller reads (`access.me.*`), mirror-table reads
  (`access.tenants`, ...), and `access.syncStatus`.

For truly public endpoints, import raw `query` / `mutation` / `action` from
`./_generated/server` directly.

```ts
import { protectedQuery, protectedMutation, protectedAction, access } from "./iam";
import { classifyAccessError } from "@usehercules/convex";
```

## Identity

One end-user identifier: the signed-in user's ID = their OIDC `sub`
(`identity.subject`). Get it with `access.me.id(ctx)`. Mirror reads expose it as
`userId`; the SDK takes it as `user_id`. Link app rows to `access.me.id(ctx)`.

`tokenIdentifier` (`issuer|sub`) is different and internal - never accept it from
browser args.

## Guarding functions

Define permission-guarded functions with the protected builders. They require a
verified identity (throw `ConvexError { code: "UNAUTHENTICATED" }` when absent),
and enforce `permission` before the handler runs (throw
`ConvexError { code: "ACCESS_DENIED", reasonCode, sourceVersion? }` on denial).
Use these for almost every function.

```ts
export const listProjects = protectedQuery({
  permission: "app.projects:read",
  tenant: (_ctx, args) => args.tenantId,       // string | (ctx,args)=>string|Promise; omit for primary
  args: { tenantId: v.string() },
  handler: async (ctx, args) => ctx.db.query("projects").collect(),
});

export const archiveProject = protectedMutation({
  permission: { allOf: ["app.projects:archive", "app.projects:write"] },
  resource: (_ctx, args) => ({ type: "app.projects", externalId: args.projectId }),
  args: { projectId: v.string() },
  handler: async (ctx, args) => { /* ... */ },
});
```

- `tenant`: `string | (ctx, args) => string | Promise<string>`. Omit for the
  deployment's primary tenant.
- `resource`: `{ type, externalId } | (ctx, args) => that | Promise`. Derive from
  trusted server data, not raw browser input.
- Raw `query` / `mutation` / `action` (from `_generated/server`) do NO auth - use
  only for truly public endpoints. A `permission`/`tenant`/`resource` guard on a
  raw builder does nothing (the checker flags it).

`permission` is a `PermissionRequirement`:

- `"app.projects:read"` - hold this one.
- `["a", "b"]` - hold every one (AND); shorthand for `{ allOf: [...] }`.
- `{ anyOf: ["a", "b"] }` - hold at least one (OR).
- `{ allOf: ["a", "b"] }` - hold every one (AND).

### In-handler checks

Reach for these only when the decision depends on data resolved inside the
handler (field-level visibility, per-item loop check, a resource you load first).

- `access.hasPermissions(ctx, requirement, { tenant?, resource? }?) => Promise<boolean>`
- `access.requirePermissions(ctx, requirement, { tenant?, resource? }?) => Promise<void>` -
  throws `ConvexError ACCESS_DENIED` on deny.

`requirement` takes the same shapes as above. `tenant` is a resolved tenant id
`string`; `resource` is `{ type, externalId }`. A resource-scoped check passes if
the caller holds the permission tenant-wide, on the resource, or on any ancestor.

## Reads

### `access.me.*` (caller-centric)

- `access.me.id(ctx) => Promise<string | undefined>` - signed-in user's ID; `undefined` if unauthenticated.
- `access.me.tenants(ctx, { cursor?: string; limit?: number; status?: "active" | "all" }?) => Promise<TenantSummariesPage>` - caller's memberships. `status: "active"` (default) keeps only active memberships in active tenants; `"all"` includes every state.
- `access.me.roles(ctx, { tenant?: string }?) => Promise<RoleSummary[]>` - caller's effective roles in a tenant (display only; do not infer authz from it).
- `access.me.groups(ctx, { tenant?: string }?) => Promise<GroupSummary[]>` - caller's groups in a tenant.
- `access.me.accessStatus(ctx, { tenant?: string }?) => Promise<TenantAccessStatusResult>` - caller's membership status in a tenant.

### Mirror tables (`access.<namespace>`)

Each mirror table exposes a uniform TRUSTED read pair - NO identity check, NO
permission gate. Authorize the calling function yourself (`protectedQuery` +
`access.requirePermissions`). Records drop Convex system fields and internal
`sourceVersion`. The mirror lags the control plane by a short sync window; treat
a not-yet-synced state as loading, not as authorization.

- `list(ctx, filters?) => Promise<ListPage<Record>>` - cursor + limit plus the table's filters (all optional). Pages cap at 100; `nextCursor?` present only when more exist - pass it back as `cursor`.
- `get(ctx, key) => Promise<Record | null>` - `key` is one of the table's unique lookups.

Every `list` filter and `get` key field is optional unless the `get` key shows it
without `?`. Each row's **Record** is the return type (defined under Types).

| Namespace                              | What it is                      | `get` key                                        | `list` filters                                                       | Record                            |
| -------------------------------------- | ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| `access.tenants`                       | tenants (workspaces/orgs)       | `{ id }` \| `{ primary: true }`                  | `status?`, `isPrimaryTenant?`                                        | `TenantRecord`                    |
| `access.users`                         | end users                       | `{ id }` \| `{ email }`                          | `email?`                                                            | `UserRecord`                      |
| `access.groups`                        | groups within a tenant          | `{ id }`                                          | `tenantId?`, `status?`                                              | `GroupRecord`                     |
| `access.roles`                         | roles (tenant / shared / app)   | `{ id }` \| `{ key, tenantId? }`                 | `tenantId?`, `isAppScope?`                                          | `RoleRecord`                      |
| `access.permissions`                   | permission definitions          | `{ id }` \| `{ key }`                            | `isAppScope?`                                                       | `PermissionRecord`                |
| `access.resourceTypes`                 | resource-type definitions       | `{ id }` \| `{ key }`                            | `parentResourceTypeId?`                                             | `ResourceTypeRecord`              |
| `access.tenantMemberships`             | user membership in a tenant     | `{ id }` \| `{ tenantId, userId }`               | `tenantId?`, `status?`, `userId?`                                   | `TenantMembershipRecord`          |
| `access.userRoleAssignments`           | user tenant-wide role grants    | `{ id }`                                          | `tenantId?`, `membershipId?`, `roleId?`                            | `UserRoleAssignmentRecord`        |
| `access.groupRoleAssignments`          | group tenant-wide role grants   | `{ id }`                                          | `tenantId?`, `groupId?`, `roleId?`                                 | `GroupRoleAssignmentRecord`       |
| `access.userResourceRoleAssignments`   | user role grants on a resource  | `{ id }`                                          | `tenantId?`, `membershipId?`, `roleId?`, `resourceTypeId?`, `externalId?` | `UserResourceRoleAssignmentRecord`  |
| `access.groupResourceRoleAssignments`  | group role grants on a resource | `{ id }`                                          | `tenantId?`, `groupId?`, `roleId?`, `resourceTypeId?`, `externalId?` | `GroupResourceRoleAssignmentRecord` |
| `access.groupMemberships`              | which users are in a group      | `{ groupId, membershipId }`                      | `groupId?`, `membershipId?`, `tenantId?`                           | `GroupMembershipRecord`           |
| `access.rolePermissions`               | which permissions a role holds  | `{ roleId, permissionId }`                       | `roleId?`, `permissionId?`                                         | `RolePermissionRecord`            |

### `access.syncStatus(ctx, { tenant?, sourceVersion }) => Promise<TargetTenantSyncStatus>`

Whether the local mirror has reached a specific control-plane write. Pass
`response.convex_source_data.version` as `sourceVersion`.

## Entry (`access.enter`)

`access.enter(ctx, { tenant?: string }?) => Promise<EnterTenantResult>`

Admission on first contact: asks the control plane to admit the signed-in user
into the tenant (default `primary`) under its entry mode. `open` creates an
active membership with the tenant default role, `approval_required` creates a
`pending_approval` membership, and `invite_only` or a matching deny rule
returns `denied` without creating anything. Idempotent: an existing membership
is returned unchanged, and the control-plane call is skipped entirely when the
mirror already shows an active membership.

Call it from an app-owned **action** (it makes an outbound HTTP call) once
after sign-in, before reading `access.me.accessStatus`. On a `sourceVersion`
result, the mirror may lag briefly; poll `access.syncStatus` with it, or rely
on a reactive `accessStatus` query to converge.

Multi-tenant apps pass the target tenant: `access.enter(ctx, { tenant })`. Each
tenant applies its own entry mode, so the same user can be `active` in one
tenant and `pending_approval` in another.

## Resource nodes (`access.resource.*`)

The component stores a resource NODE graph the app owns and writes (nodes hold NO
app data). Resource-scoped permission checks and the ancestor walk use it.

- `access.resource.write(ctx, { type, externalId, parent?, tenant? }) => Promise<ResourceNode | null>` - upserts a node. `parent` is `{ type, externalId }`. Needs a mutation/action ctx. Trusted write, no permission gate - gate the surrounding handler.
- `access.resource.delete(ctx, { type, externalId, tenant? }) => Promise<{ deleted: boolean }>` - removes one node. Children are left for the app to manage.
- `access.resource.list(ctx, { type?, parent?, permission?, tenant?, cursor?, limit? }?) => Promise<ResourceNodesPage>` - lists nodes. With `permission`, the page is access-scoped to nodes the caller may access under that permission.
- `access.resource.get(ctx, { type, externalId, permission?, tenant? }) => Promise<ResourceNode | null>` - reads one node; with `permission`, returns `null` when denied.

## IAM writes (SDK)

Reads above come from the local mirror. To WRITE IAM state (memberships, role
assignments, groups, invitations), create app-owned Convex actions that call the
generated `@usehercules/sdk` with `actor_token_identifier` derived from
`ctx.auth.getUserIdentity().tokenIdentifier`. Never accept that token from args.
The one packaged write is `access.enter` (deployment entry, above).

## Error classification

`classifyAccessError(error) => AccessErrorClassification | null`. Local
`ConvexError ACCESS_DENIED` maps to `admission` (membership reason codes:
`membership_pending_approval`, `membership_blocked`, `membership_suspended`,
`membership_removed`, `membership_missing`), `permission` (`permission_denied`),
or `temporary` (`mirror_not_ready`). SDK problem responses map to `access` /
`synchronization` / `operation`. Config and unknown failures return `null`.

## Static checker

```bash
hercules-convex-iam-check convex
```

Catches undeclared permission / resource-type literals (validated against
`.hercules/iam.jsonc`) and guard options passed to a raw builder. It does not
prove runtime role decisions.

## Types

```ts
type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

// ── permission requirement (builder option + hasPermissions/requirePermissions) ─
type PermissionRequirement =
  | string                            // one key
  | string[]                          // allOf (AND)
  | { anyOf: string[] }               // at least one (OR)
  | { allOf: string[] };              // every one (AND); empty is rejected (deny)
type PermissionOptions = { tenant?: string; resource?: ResourceRef };

// ── me.* return shapes ──────────────────────────────────────────────────────────
// Role scope: tenantId=<id> → tenant-scoped; tenantId=null & isAppScope=false →
// shared; tenantId=null & isAppScope=true → app-scoped (app-wide authority).
type RoleSummary = { roleId: string; roleKey: string; roleName: string; isAppScope: boolean; tenantId: string | null };
type GroupSummary = { groupId: string; name: string; status: "active" | "disabled" };
type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};
type TenantSummariesPage = { tenants: TenantSummary[]; nextCursor?: string };

// ── mirror `list`/`get` return shapes ───────────────────────────────────────────
// Records are the row's columns minus _id / _creationTime / sourceVersion.
// `list` returns ListPage<Record>; `get` returns Record | null.
type ListPage<V> = { items: V[]; nextCursor?: string };

type TenantRecord = {
  id: string; name: string; isPrimaryTenant: boolean;
  status: "active" | "disabled";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null; updatedAt: number;
};
type UserRecord = {
  id: string; name: string; email: string; emailVerified: boolean;
  image?: string; phone?: string; phoneVerified: boolean; updatedAt: number;
};
type GroupRecord = { id: string; tenantId: string; name: string; description?: string; status: "active" | "disabled"; updatedAt: number };
type RoleRecord = {
  id: string; key: string; name: string; description: string | null;
  tenantId: string | null; isAppScope: boolean; updatedAt: number;
};
type PermissionRecord = { id: string; key: string; isAppScope: boolean; updatedAt: number };
type ResourceTypeRecord = { id: string; key: string; name: string; parentResourceTypeId: string | null; updatedAt: number };
type TenantMembershipRecord = { id: string; tenantId: string; userId: string; status: MembershipStatus; updatedAt: number };
type RolePermissionRecord = { roleId: string; permissionId: string; updatedAt: number };
type GroupMembershipRecord = { groupId: string; membershipId: string; tenantId: string; updatedAt: number };
type UserRoleAssignmentRecord = { id: string; tenantId: string; membershipId: string; roleId: string; expiresAt?: number; updatedAt: number };
type GroupRoleAssignmentRecord = { id: string; tenantId: string; groupId: string; roleId: string; expiresAt?: number; updatedAt: number };
type UserResourceRoleAssignmentRecord = {
  id: string; tenantId: string; membershipId: string; roleId: string;
  resourceTypeId: string; externalId: string; expiresAt?: number; updatedAt: number;
};
type GroupResourceRoleAssignmentRecord = {
  id: string; tenantId: string; groupId: string; roleId: string;
  resourceTypeId: string; externalId: string; expiresAt?: number; updatedAt: number;
};

// ── resource nodes ──────────────────────────────────────────────────────────────
type ResourceRef = { type: string; externalId: string };
type ResourceNode = { type: string; externalId: string; parent?: ResourceRef };
type ResourceNodesPage = { resources: ResourceNode[]; nextCursor?: string };

// ── me.accessStatus / syncStatus return shapes ──────────────────────────────────
type TenantAccessStatusResult =
  | { kind: "principal"; membershipId: string; status: MembershipStatus; stateVersion: number }
  | { kind: "fallback"; reason: "identity_missing" | "identity_invalid" | "unexpected_issuer" | "mirror_not_ready" | "tenant_missing" | "membership_missing"; stateVersion?: number };

// ── enter return shape ──────────────────────────────────────────────────────────
// sourceVersion: pass to access.syncStatus before relying on mirror reads; null
// when the mirror already showed an active membership (no control-plane call).
type EnterTenantResult = {
  allowed: boolean;
  status: "active" | "pending_approval" | "denied";
  reason: "deny_rule" | "not_allowlisted" | "invite_only" | "tenant_disabled" | null;
  membershipId: string | null;
  sourceVersion: number | null;
};

type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | { state: "ready"; currentSourceVersion: number; targetSourceVersion: number; tenantId: string; membershipId: string }
  | { state: "denied"; reasonCode: string; currentSourceVersion: number; targetSourceVersion: number; tenantId?: string; membershipId?: string }
  | { state: "failed"; reasonCode: string; currentSourceVersion?: number; targetSourceVersion: number };
```

## Operational notes

- Mirror reads may briefly lag a successful write. Treat a not-yet-synced state as loading, not denial.
- Page resource/mirror lists with `cursor`; do not `.collect()` unbounded tables.
- IAM actions use Convex's default runtime. Do not add `"use node"`.
