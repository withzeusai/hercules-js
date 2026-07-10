---
"@usehercules/convex": minor
---

Add `access.members.list` and `access.members.get`: composed members-directory reads.

`members.list(ctx, { tenant?, status?, cursor?, limit? })` returns one page of a tenant's members joined with user info and `heldVia`-tagged roles (`direct` vs `group`), defaulting to active members. `members.get(ctx, { tenant?, membershipId })` returns the same shape for one member plus `resourceRoleAssignments` with resource type keys. Replaces the per-member `users.get` + `userRoleAssignments.list` + role-resolution N+1 loops in admin directories; trusted reads, authorize the calling function.
