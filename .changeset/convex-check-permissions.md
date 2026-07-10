---
"@usehercules/convex": minor
---

Add `access.checkPermissions(ctx, checks)`: batched permission checks.

Takes `Array<{ permission, tenant?, resource? }>` and returns `boolean[]` aligned by index, in one component round trip (chunked internally past the component's 100-check limit). Replaces per-row `hasPermissions` fan-outs when building capability flags for lists; combined with tenant-wide subsumption (a resource-scoped check passes when the permission is held tenant-wide or on an ancestor), no separate baseline pass is needed.
