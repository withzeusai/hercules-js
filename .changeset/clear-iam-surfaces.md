---
"@usehercules/convex": major
---

Replace the public managed IAM API with one tenant-based model across
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

Keep deployment entry, signed-in management, and trusted service authority on
separate package surfaces. Reject existing-row IAM handlers without a loaded
resource tenant and row capability checks without a concrete resource.
