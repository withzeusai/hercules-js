---
"@usehercules/auth-tanstack": minor
---

Keep sessions authenticated when no refresh token was issued.

The default sign-in scope is `openid profile email`, which grants no refresh
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
- `ConvexProviderWithHerculesAuth` falls back to the current ID token when a
  forced refresh resolves empty or rejects, so Convex never receives `null` for a
  live session.
- New `herculesAuthMiddleware({ scope })` option, with `HERCULES_AUTH_SCOPE` (or
  `AUTH_SCOPE`) as its environment fallback, to change the scopes requested when
  a sign-in call passes none. The built-in default is unchanged; apps on Hercules
  Auth should set `"openid profile email offline_access"` so sessions can be
  renewed.
