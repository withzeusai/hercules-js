---
"@usehercules/convex": minor
---

Read-surface and vocabulary consistency across the IAM surface.

- Uniform list envelopes: `access.me.tenants` and `access.resource.list` return the same `ListPage` (`{ items, nextCursor? }`) as every other list; `TenantSummariesPage` and `ResourceNodesPage` are gone.
- One lifecycle vocabulary end to end: tenant/group status is `"active" | "archived"` in storage, sync, and the read surface (was `disabled`), matching the SDK's archive/unarchive verbs. The entry denial reason `tenant_disabled` is now `tenant_archived`.
- `TenantRecord.accountEntryMode` is now `accessMode`, matching the SDK's `access_mode` field end to end (mirror column renamed with the sync protocol).
- Summary shapes use the same field style as records: `RoleSummary`/`MemberRoleSummary` expose `id`/`key`/`name` (was `roleId`/`roleKey`/`roleName`), `TenantSummary` exposes `id`/`name`, `GroupSummary` exposes `id`.
