---
"@usehercules/convex": minor
---

Rename the user avatar field from `image` to `avatar` on the app-facing read shapes (`UserRecord` from `access.users`, and `members.*`'s `user`), matching the auth SDK's `useUser().avatar`. Storage and the sync protocol keep the internal `image` column; this is a read-surface rename only.
