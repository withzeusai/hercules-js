# @usehercules/convex

## 1.1.0

### Minor Changes

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add `access.enter`: deployment entry for the signed-in end user.

  - **`access.enter(ctx, { tenant? })`**: asks the control plane to admit the caller into the tenant (default `primary`) under its entry mode: `open` creates an active membership with the tenant default role, `approval_required` creates a `pending_approval` membership, and `invite_only` or a matching deny rule returns `denied` without creating anything. Idempotent; skips the network call when the mirror already shows an active membership. Must run inside an action.
  - This restores the admission capability lost when `enterDeployment` was removed with the legacy `access-admin` client: without it, new end users signing in to an open tenant were never admitted and never appeared in the dashboard Users list.
  - Bumps `@usehercules/sdk` to `^1.15.11` (adds `iam.tenants.evaluateAccess`).

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add `access.checkPermissions(ctx, checks)`: batched permission checks.

  Takes `Array<{ permission, tenant?, resource? }>` and returns `boolean[]` aligned by index, in one component round trip (chunked internally past the component's 100-check limit). Replaces per-row `hasPermissions` fan-outs when building capability flags for lists; combined with tenant-wide subsumption (a resource-scoped check passes when the permission is held tenant-wide or on an ancestor), no separate baseline pass is needed.

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add `access.members.list` and `access.members.get`: composed members-directory reads.

  `members.list(ctx, { tenant?, status?, cursor?, limit? })` returns one page of a tenant's members joined with user info and `heldVia`-tagged roles (`direct` vs `group`), defaulting to active members. `members.get(ctx, { tenant?, membershipId })` returns the same shape for one member plus `resourceRoleAssignments` with resource type keys. Replaces the per-member `users.get` + `userRoleAssignments.list` + role-resolution N+1 loops in admin directories; trusted reads, authorize the calling function.

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Read-surface and vocabulary consistency across the IAM surface.

  - Uniform list envelopes: `access.me.tenants` and `access.resource.list` return the same `ListPage` (`{ items, nextCursor? }`) as every other list; `TenantSummariesPage` and `ResourceNodesPage` are gone.
  - One lifecycle vocabulary end to end: tenant/group status is `"active" | "archived"` in storage, sync, and the read surface (was `disabled`), matching the SDK's archive/unarchive verbs. The entry denial reason `tenant_disabled` is now `tenant_archived`.
  - `TenantRecord.accountEntryMode` is now `accessMode`, matching the SDK's `access_mode` field end to end (mirror column renamed with the sync protocol).
  - Summary shapes use the same field style as records: `RoleSummary`/`MemberRoleSummary` expose `id`/`key`/`name` (was `roleId`/`roleKey`/`roleName`), `TenantSummary` exposes `id`/`name`, `GroupSummary` exposes `id`.

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - `access.resource.write` now returns `Promise<ResourceNode>` and fails loud instead of silently no-op'ing.

  Previously it returned `ResourceNode | null` where null meant nothing was written (unresolved tenant, undeclared resource type) and a mismatched `parent` silently dropped the parent edge; callers that discarded the result could commit app rows with no backing access node. It now throws `ConvexError { code: "ACCESS_DENIED", reasonCode: "mirror_not_ready" }` (temporary) when the mirror has no tenant yet, and `ConvexError { code: "IAM_CONFIG" }` when the type is undeclared or the supplied parent does not match the type's declared parent, rolling the calling mutation back so app data and the access graph stay consistent.

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Rename the user avatar field from `image` to `avatar` on the app-facing read shapes (`UserRecord` from `access.users`, and `members.*`'s `user`), matching the auth SDK's `useUser().avatar`. Storage and the sync protocol keep the internal `image` column; this is a read-surface rename only.

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add `access.waitForSync(ctx, { sourceVersion, tenant?, timeoutMs? })`: awaits the mirror catching up to a control-plane write inside an action (polls `syncStatus` with backoff). Resolves with the terminal status (`ready` / `denied` / `failed`) and throws a `temporary`-classified `mirror_not_ready` error on timeout. Replaces hand-rolled sleep loops after SDK writes.

## 1.0.1

### Patch Changes

- [#73](https://github.com/withzeusai/hercules-js/pull/73) [`2d93e33`](https://github.com/withzeusai/hercules-js/commit/2d93e3356506622c94633e4845de4a6a9fb55c2a) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Replace the public managed IAM API with one tenant-based model across
  authorization builders, mirrored reads, management actions, and trusted
  service actions. Organize actions by resource, require exclusive `{ id }` or
  `{ key }` role references, and remove the previous scope-, organization-, and
  member-named aliases.

  Use uniform discriminated grant inputs and results, including grant IDs,
  nullable expiry, role or permission details, and resource applicability. Use
  one `updateGrant` action for role assignments, user permission overrides, and
  resource grants.

  Paginate tenant users, tenant groups, group members, user groups, and direct
  resource subjects in pages of at most 100. Add role descriptions through the
  v4-only projection protocol with required role descriptions.

  Keep tenant access evaluation, signed-in management, and trusted service
  authority on separate package surfaces. Reject existing-row IAM handlers
  without a loaded resource tenant and row capability checks without a concrete
  resource. Rename the default-tenant mirror read to `getTenantAccessStatus`.
  Require creator bootstrap workflows to verify active access in both the default
  app tenant and the target tenant before using service authority.

- [#73](https://github.com/withzeusai/hercules-js/pull/73) [`2d93e33`](https://github.com/withzeusai/hercules-js/commit/2d93e3356506622c94633e4845de4a6a9fb55c2a) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Keep IAM actions in Convex's default runtime.

## 1.0.0

### Major Changes

- [#40](https://github.com/withzeusai/hercules-js/pull/40) [`3037113`](https://github.com/withzeusai/hercules-js/commit/30371131ec9d1fb3faca6813d5025eb576c0107d) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add Hercules Convex IAM helpers, component, sync route, and source checker.
