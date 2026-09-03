---
"@usehercules/auth-tanstack": minor
---

Keep sessions authenticated when no refresh token was issued.

The default sign-in scope was `openid profile email`, which grants no refresh
token from Hercules Auth (that needs `offline_access`). Every refresh action
then resolved empty, and callers read empty as "signed out" while the current
tokens still had hours left. Convex hit this on every page: `ConvexProviderWithAuth`
re-requests the token with `forceRefreshToken: true` right after confirming the
cached one, got nothing back, and dropped to unauthenticated for the rest of the
page -- `useConvexAuth().isAuthenticated` stayed `false` and every private query
threw, even though `useAuth().user` was set and the ID token was valid.

- `refreshIdTokenAction`, `refreshAccessTokenAction`, and `refreshAuthAction`
  now return the current session's tokens/state when no refresh grant is possible
  (no refresh token, or the grant failed) and the session is still valid. They
  still return nothing once the session has actually expired.
- `ConvexProviderWithHerculesAuth` now mirrors Convex's own `@convex-dev/workos`
  bridge: `fetchAccessToken` ignores `forceRefreshToken` and always answers from
  the ID-token store (which refreshes on its own ahead of expiry), so Convex's
  post-confirmation refetch costs no refresh grant and never receives `null` for
  a live session.
- The default sign-in scope is now `openid profile email offline_access`, so a
  refresh token is issued and sessions can actually be renewed. Providers that
  reject `offline_access` can narrow it with the new
  `herculesAuthMiddleware({ scope })` option or its `HERCULES_AUTH_SCOPE` (or
  `AUTH_SCOPE`) environment fallback.
