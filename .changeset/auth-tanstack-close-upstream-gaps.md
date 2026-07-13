---
"@usehercules/auth-tanstack": minor
---

Close functional gaps against upstream `@workos/authkit-tanstack-react-start`:

- **Sessions survive access-token expiry.** The session cookie now uses a long, configurable `Max-Age` (default ~400 days; `HERCULES_AUTH_COOKIE_MAX_AGE` / `cookieMaxAge`) instead of the access token's lifetime, and any server-side read (`getAuth`, hook actions) transparently refreshes an expired session with the sealed refresh token. Session resolution is memoized per request and rotation-safe (a second refresh in the same request uses the rotated refresh token).
- **Server code can no longer leak into the client bundle.** All server-function and route-handler bodies are loaded via dynamic import; the root barrel's static import graph no longer reaches `openid-client`.
- **Recent-auth enforcement.** New `checkRecentAuth({ maxAge })` server function (the enforcement half of `useRecentAuth`), and `maxAge`/`loginHint` options on `getSignInUrl`/`getSignUpUrl`/`getAuthorizationUrl`/`handleSignInRoute` forwarded as OIDC `max_age`/`login_hint`.
- **Callback hardening.** The post-callback redirect is anchored to the callback's origin (closes an open redirect via `returnPathname`); `onError` responses get the failed flow's verifier-delete cookies appended; a missing `code` evicts the flow's verifier; missing/unknown `state` surfaces typed `OAuthStateMismatchError`/`PKCECookieMissingError`.
- **New config knobs.** `HERCULES_AUTH_REDIRECT_URI` env fallback for the middleware `redirectUri`, plus session cookie name/domain overrides (`HERCULES_AUTH_COOKIE_NAME`, `HERCULES_AUTH_COOKIE_DOMAIN` / `cookieDomain`).
- **Expanded exports.** Root entry now exports the hook-backing actions (`checkSessionAction`, `getAccessTokenAction`, `refreshAccessTokenAction`, `getIdTokenAction`, `refreshIdTokenAction`, `refreshAuthAction`), the typed errors, and `ClientUserInfo`/`SignInUrlOptions`/`RecentAuthResult` types.
- **Client polish.** `useAuth({ ensureSignedIn: true })` narrows `user` to non-null once `loading` is false; the token store skips redundant notifications when a silent revalidation returns an unchanged token.
