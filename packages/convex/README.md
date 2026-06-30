# @usehercules/convex

Convex integration for Hercules-managed IAM. This file is the authoritative,
agent-readable contract: every exported helper is documented below with its
input parameters and output shape. Read this instead of grepping `node_modules`
`.d.ts` files. Do not infer public behavior from component implementation files.

The model is ReBAC and allow-only. Subjects (users and groups) are members of
**tenants**. Roles hold permissions. A subject gets a role either tenant-wide
(a role assignment) or on a specific resource node (a resource role assignment),
and a resource assignment also covers every descendant of that node. There is no
deny, no wildcard, and no permission override.

## Package entry points

```ts
import { createIam, classifyIamError } from "@usehercules/convex";
import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
import { registerIamRoutes } from "@usehercules/convex/http";
import herculesComponent from "@usehercules/convex/convex.config"; // defineComponent("hercules")
```

| Export path                         | Provides                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `@usehercules/convex`               | `createIam`, `classifyIamError`, public types               |
| `@usehercules/convex/iam-helpers`   | `createResourceCreatorBootstrapAction`                      |
| `@usehercules/convex/http`          | `registerIamRoutes`                                         |
| `@usehercules/convex/convex.config` | the `hercules` Convex component definition                  |
| `hercules-convex-iam-check` (bin)   | static source checker (`hercules-convex-iam-check convex`)  |

## User identity model

There is ONE user identifier across IAM: the Hercules Auth user id = the OIDC
`sub` = `identity.subject` from `ctx.auth.getUserIdentity()`. `getCurrentUserId(ctx)`
returns it. Mirror reads expose it as `userId`. The SDK takes the same value as
`user_id` on writes.

`tokenIdentifier` (`issuer|sub`) is DIFFERENT. The client passes it to the
component for issuer fencing and identity resolution; never accept it from
browser args. Link app rows to `getCurrentUserId(ctx)`, not to `tokenIdentifier`.

## Setup

Register the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import hercules from "@usehercules/convex/convex.config";

const app = defineApp();
app.use(hercules);
export default app;
```

Wire IAM once in `convex/iam.ts`, then re-export:

```ts
import { createIam } from "@usehercules/convex";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

export const iam = createIam({ query, mutation, action, components });
```

### `createIam(options)` parameters (`CreateIamOptions<DataModel>`)

| Field           | Type                                | Req | Meaning                                          |
| --------------- | ----------------------------------- | --- | ------------------------------------------------ |
| `query`         | `QueryBuilder<DataModel, "public">` | yes | The generated `query` builder.                   |
| `mutation`      | `MutationBuilder<…, "public">`      | yes | The generated `mutation` builder.                |
| `action`        | `ActionBuilder<…, "public">`        | yes | The generated `action` builder.                  |
| `components`    | `Record<string, unknown>`           | no  | The generated `components`; resolves the component. |
| `component`     | `IamComponent`                      | no  | Explicit component, bypasses lookup.             |
| `componentName` | `string`                            | no  | Component name (default `"hercules"`).           |

Returns `Iam<DataModel>` (below). Throws if the component cannot be resolved.

## The `createIam` surface

`tenant` defaults to the deployment's primary tenant everywhere it is optional;
the primary-tenant id is resolved inside the component and never exposed.

### Function builders

- `publicQuery` / `publicMutation` / `publicAction`: the raw generated builders.
  No authentication. Use for truly public endpoints.
- `query` / `mutation` / `action`: auth-aware. They require a verified identity
  and throw `ConvexError { code: "UNAUTHENTICATED", reasonCode: "missing_identity" }`
  when absent. Add `{ permission, tenant?, resource? }` to the definition object
  to also enforce a permission before the handler runs; on denial they throw
  `ConvexError { code: "ACCESS_DENIED", reasonCode, sourceVersion? }`.

```ts
import { v } from "convex/values";
import { iam } from "./iam";

export const listProjects = iam.query({
  permission: "app.projects:read",
  tenant: (_ctx, args) => args.tenantId, // string | (ctx,args)=>string; omit for primary
  args: { tenantId: v.string() },
  handler: async (ctx, args) => ctx.db.query("projects").collect(),
});

export const archiveProject = iam.mutation({
  permission: "app.projects:archive",
  resource: (_ctx, args) => ({ type: "app.projects", externalId: args.projectId }),
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    /* ... */
  },
});
```

`tenant` is `string | (ctx, args) => string | Promise<string>`. `resource` is
`{ type, externalId } | (ctx, args) => { type, externalId } | Promise<…>`. Derive
the resource from trusted server data, not raw browser input.

### In-handler authorization

- `iam.can(ctx, permission, { tenant?, resource? }?) => Promise<boolean>`
- `iam.require(ctx, permission, { tenant?, resource? }?) => Promise<void>` —
  throws `ConvexError { code: "ACCESS_DENIED", reasonCode, sourceVersion? }` on deny.

Here `tenant` is the resolved tenant id `string`, and `resource` is
`{ type, externalId }`. A resource-scoped check authorizes if the caller holds a
role with the permission tenant-wide, OR on the resource, OR on any ancestor of
the resource in the component resource graph.

```ts
if (!(await iam.can(ctx, "app.documents:read", { resource: { type: "app.documents", externalId: id } }))) {
  return null;
}
```

### `getCurrentUserId(ctx) => Promise<string | undefined>`

The verified OIDC subject (the Hercules Auth user id). `undefined` when
unauthenticated.

### Caller-centric reads (`me.*`)

- `me.tenants(ctx, { cursor?, limit?, status? }?) => Promise<TenantSummariesPage>` —
  the caller's tenant memberships. `status: "active"` keeps only active
  memberships in active tenants.
- `me.roles(ctx, { tenant? }?) => Promise<RoleSummary[]>` — the caller's effective
  roles in a tenant (display only; do not infer authorization from it).
- `me.accessStatus(ctx, { tenant? }?) => Promise<IamTenantAccessStatusResult>` —
  the caller's membership status in a tenant.

### Mirror reads

Each admin read self-gates on the matching system read capability in the tenant
(`system.access.tenants:read`, `system.access.users:read`,
`system.access.roles:read`) and returns its empty value when the caller lacks it.
Reads come from the local mirror, which lags the control plane by a short sync
window. Treat a not-yet-synced state as loading, not as proof of authorization.

- `tenant.list(ctx, { tenant?, cursor?, limit? }?) => Promise<TenantDetailsPage>`
- `tenant.get(ctx, { tenant? }?) => Promise<TenantDetail | null>`
- `user.list(ctx, { tenant?, cursor?, limit?, status? }?) => Promise<TenantUsersPage>`
- `user.get(ctx, { tenant?, userId }) => Promise<TenantUser | null>`
- `group.list(ctx, { tenant?, cursor?, limit? }?) => Promise<TenantGroupsPage>`
- `group.get(ctx, { tenant?, groupId }) => Promise<TenantGroup | null>`
- `group.members(ctx, { tenant?, groupId, cursor?, limit? }) => Promise<TenantUsersPage>`
- `role.list(ctx, { tenant? }?) => Promise<RoleSummary[]>`
- `role.get(ctx, { tenant?, roleId }) => Promise<RoleDetail | null>`

Paginated reads cap pages at 100 and return `nextCursor?` (present only when more
pages exist); pass it back as `cursor`.

### Resource nodes (`resource.*`)

The component stores a resource NODE graph that the app owns and writes. Nodes
are what resource-scoped checks and the ancestor walk use.

- `resource.write(ctx, { type, externalId, parent?, data?, tenant? }) => Promise<ResourceNode | null>` —
  upserts a node. `parent` is `{ type, externalId }`. Requires a mutation/action
  context. This is a trusted write with no permission gate; gate the surrounding
  handler if needed.
- `resource.delete(ctx, { type, externalId, tenant? }) => Promise<{ deleted: boolean }>` —
  removes a single node. Child nodes are left for the app to manage.
- `resource.list(ctx, { type?, parent?, permission?, tenant?, cursor?, limit? }?) => Promise<ResourceNodesPage>` —
  lists nodes. When `permission` is provided the page is access-scoped: only nodes
  the caller may access under that permission are returned. This replaces the old
  `filterAuthorizedResources` helper.
- `resource.get(ctx, { type, externalId, permission?, tenant? }) => Promise<ResourceNode | null>` —
  reads one node; with `permission`, returns `null` when the caller is denied.

### `syncStatus(ctx, { tenant?, sourceVersion }) => Promise<TargetTenantSyncStatus>`

Whether the local mirror has reached a specific control-plane write. Pass
`response.convex_source_data.version` as `sourceVersion`.

## Component function references (app-template integration contract)

`createIam` calls these component functions (`components.hercules.*`). The app
rarely references them directly except where a helper requires a `FunctionReference`
(for example the creator-bootstrap helper):

- `checks.check`, `checks.checkMany`
- `queries.getTenantAccessStatus`, `queries.listMyTenants`, `queries.listMyRoles`,
  `queries.getTargetTenantSyncStatus`, `queries.getTenant`, `queries.listTenants`,
  `queries.listTenantUsers`, `queries.getTenantUser`, `queries.listTenantGroups`,
  `queries.getTenantGroup`, `queries.listGroupMembers`, `queries.listTenantRoles`,
  `queries.getTenantRole`
- `resources.list`, `resources.get`, `resources.write`, `resources.remove`
- `sync.applySync`

## Types

```ts
type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  isSystemRole: boolean;
  isRestricted: boolean;
};

type DirectRoleAssignment = RoleSummary & { assignmentId: string; expiresAt: number | null };

type TenantSummary = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

type TenantDetail = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  lifecycleStatus: "active" | "archived";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

type TenantUser = {
  userId: string;
  status: MembershipStatus;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

type TenantGroup = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
  memberCount: number;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

type RoleDetail = RoleSummary & { description: string | null; permissionKeys: string[] };

type ResourceRef = { type: string; externalId: string };
type ResourceNode = { type: string; externalId: string; parent?: ResourceRef; data?: unknown };

type IamTenantAccessStatusResult =
  | { kind: "principal"; membershipId: string; status: MembershipStatus; stateVersion: number }
  | {
      kind: "fallback";
      reason:
        | "identity_missing" | "identity_invalid" | "unexpected_issuer"
        | "mirror_not_ready" | "tenant_missing" | "membership_missing";
      stateVersion?: number;
    };

type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | { state: "ready"; currentSourceVersion: number; targetSourceVersion: number; tenantId: string; membershipId: string }
  | { state: "denied"; reasonCode: string; currentSourceVersion: number; targetSourceVersion: number; tenantId?: string; membershipId?: string }
  | { state: "failed"; reasonCode: string; currentSourceVersion?: number; targetSourceVersion: number };

// Pages: { tenants | users | groups | resources: T[]; nextCursor?: string }.
```

## IAM writes (SDK)

Create app-owned Convex actions for IAM writes and REST reads. Call the generated
`@usehercules/sdk` directly with `actor_token_identifier` derived from
`ctx.auth.getUserIdentity().tokenIdentifier`. Never accept that token from args.

## Error classification

### `classifyIamError(error) => IamErrorClassification | null`

Classifies runtime IAM denials. Local `ConvexError ACCESS_DENIED` denials map to
`admission` (membership status reason codes such as `membership_pending_approval`,
`membership_blocked`, `membership_suspended`, `membership_removed`,
`membership_missing`), `permission` (`permission_denied`), or `temporary`
(`mirror_not_ready`). SDK problem responses map to `access` / `synchronization` /
`operation`. Configuration and unknown failures return `null`.

## Webhook routes

### `registerIamRoutes(http, options)`

Registers the projection-sync webhook the control plane posts to. Verifies the
standard-webhooks signature, validates the v5 payload, applies it via the
component `applySync` mutation, and maps outcomes to HTTP statuses (200
applied/duplicate, 409 recoverable conflict, 400 payload problem, 401 bad
signature, 500 missing secret).

```ts
import { httpRouter } from "convex/server";
import { registerIamRoutes } from "@usehercules/convex/http";
import { httpAction } from "./_generated/server";

const http = httpRouter();
registerIamRoutes(http, { httpAction });
export default http;
```

Options: `{ httpAction, components?, component?, componentName?, path?, envVarName? }`.
Default path `/_hercules/iam/sync`; default secret env var `HERCULES_SYNC_SECRET`.

## Resource creator bootstrap

`createResourceCreatorBootstrapAction` (from `@usehercules/convex/iam-helpers`)
grants one fixed initial resource role to the trusted creator of a provisioning
row, gating on active root and target tenant access. See the helper's typed
options; the browser passes only `resourceId`.

## Static checker

```bash
hercules-convex-iam-check convex
```

Catches deterministic source patterns (raw exported Convex builders, optional
tenant ids on tenant-owned rows, unsafe service authority). It does not prove
runtime role decisions or control-plane writes are authorized.

## Operational notes

- Mirror reads may briefly lag a successful write. Treat a not-yet-synced state
  as loading, not as denial.
- `HERCULES_API_KEY` is the server-side service credential; `HERCULES_SYNC_SECRET`
  verifies the sync webhook.
- IAM actions use Convex's default runtime. Do not add `"use node"`.
- Do not call `.collect()` on unbounded tables; page resource lists with `cursor`.
