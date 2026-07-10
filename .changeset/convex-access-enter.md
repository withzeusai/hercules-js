---
"@usehercules/convex": minor
---

Add `access.enter`: deployment entry for the signed-in end user.

- **`access.enter(ctx, { tenant? })`**: asks the control plane to admit the caller into the tenant (default `primary`) under its entry mode: `open` creates an active membership with the tenant default role, `approval_required` creates a `pending_approval` membership, and `invite_only` or a matching deny rule returns `denied` without creating anything. Idempotent; skips the network call when the mirror already shows an active membership. Must run inside an action.
- This restores the admission capability lost when `enterDeployment` was removed with the legacy `access-admin` client: without it, new end users signing in to an open tenant were never admitted and never appeared in the dashboard Users list.
- Bumps `@usehercules/sdk` to `^1.15.11` (adds `iam.tenants.evaluateAccess`).
