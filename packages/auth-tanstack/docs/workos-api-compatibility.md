# WorkOS AuthKit API compatibility

`@usehercules/auth-tanstack` is modeled on WorkOS's
[`@workos/authkit-tanstack-react-start`](https://github.com/workos/authkit-tanstack-start).
The goal is **~90% API compatibility** so that code written against WorkOS's
helpers ports with minimal changes. The fundamental difference is the session
model:

- **WorkOS** seals a session (`{ user, accessToken, refreshToken, impersonator }`)
  into a cookie via `@workos/authkit-session`, and every helper reads/writes that
  session.
- **Hercules** authenticates against a generic **OIDC provider** with
  `openid-client`. We seal an equivalent session (`{ accessToken, idToken,
refreshToken, expiresAt }`) into a cookie and derive the WorkOS-shaped
  `UserInfo`/`User` by mapping standard OIDC ID-token claims.

Because identity comes from OIDC claims rather than a WorkOS user record, a few
fields are provider-dependent (see [Claim mapping](#claim-mapping)).

## Status

| Tier | Item                                                                                                                                                 | Status                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1    | Sealed session abstraction (`{ accessToken, idToken, refreshToken }`)                                                                                | ✅ Done                              |
| 1    | `getAuth()` → `UserInfo \| NoUserInfo`                                                                                                               | ✅ Done                              |
| 1    | Real domain types (`User`, `Session`, `UserInfo`, `NoUserInfo`, …)                                                                                   | ✅ Done                              |
| 1    | `signOut()`, `getSignInUrl()`, `getSignUpUrl()`, `getAuthorizationUrl()`                                                                             | ✅ Done                              |
| 1    | Align `handleCallbackRoute`'s `onSuccess` payload to WorkOS shape                                                                                    | ⏳ Deferred (kept OIDC-native shape) |
| 2    | `./client` entry: `AuthKitProvider`, `useAuth`, `useAccessToken`, `useTokenClaims`, `useRecentAuth`                                                  | ✅ Done                              |
| 2    | Client RPC actions (`getAuthAction`, `checkSessionAction`, `getAccessTokenAction`, `refreshAccessTokenAction`, `refreshAuthAction`, `getSignOutUrl`) | ✅ Done                              |
| 2    | Token refresh (`refreshTokenGrant`) + `useAccessToken`                                                                                               | ✅ Done                              |
| 2    | `useIdToken` + ID-token actions (Hercules extra; WorkOS has no ID-token support)                                                                     | ✅ Done                              |
| 2    | `checkRecentAuth({ maxAge })` + `max_age` forwarding on sign-in URLs                                                                                 | ✅ Done                              |
| 2    | Server-side session auto-refresh + long-lived session cookie                                                                                         | ✅ Done (refresh-on-read, not middleware) |
| 3    | `herculesAuthMiddleware` (config: `redirectUri`, `cookieSameSite`, `cookieMaxAge`, `cookieDomain`)                                                   | ✅ Done (config-only)                |
| 3    | `getAuthKitContext`-style per-request auth context                                                                                                   | ⛔ Not started (internal per-request session cache exists; no public accessor) |
| 3    | `switchToOrganization`, org/role claim machinery, `getOrganizationAction`                                                                            | ⛔ Not started                       |
| 3    | Typed errors (`OAuthStateMismatchError`, `PKCECookieMissingError`)                                                                                   | ✅ Done                              |

## Full export comparison

### Main entry (`.`)

| WorkOS export                                                                             | Hercules            | Notes                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handleCallbackRoute`                                                                     | ✅                  | `onSuccess` payload is OIDC-native (`{ accessToken, idToken, refreshToken, expiresIn, scope, claims, state }`), not WorkOS's `{ user, … }`.      |
| `handleSignInRoute`                                                                       | ✅ (Hercules extra) | WorkOS has no such handler; it uses `getSignInUrl`. We ship both.                                                                                |
| `getAuth()`                                                                               | ✅                  | Reads the sealed session cookie, maps OIDC claims → `UserInfo`.                                                                                  |
| `signOut(options?)`                                                                       | ✅                  | Clears the session and redirects to the OIDC `end_session_endpoint` when the provider advertises one (with `id_token_hint`), else to `returnTo`. |
| `getSignInUrl(options?)`                                                                  | ✅                  | Accepts a `returnPathname` string shorthand or options object, like WorkOS.                                                                      |
| `getSignUpUrl(options?)`                                                                  | ✅                  | Maps to the `screen_hint=sign-up` authorization param (provider-dependent).                                                                      |
| `getAuthorizationUrl(options)`                                                            | ✅                  | Sets the PKCE verifier cookie as a side effect; call on user action, not in a loader.                                                            |
| `switchToOrganization(...)`                                                               | ⛔                  | Tier 3.                                                                                                                                          |
| `checkRecentAuth({ maxAge })`                                                             | ✅                  | From the `auth_time` claim; fails closed. Pair with `getSignInUrl({ maxAge })` (OIDC `max_age`) to force reauth.                                 |
| `authkitMiddleware`                                                                       | ✅ (different)      | `herculesAuthMiddleware` carries app-wide config (`redirectUri`, `cookieSameSite`, `cookieMaxAge`, `cookieDomain`). Unlike WorkOS it does no per-request work: session auto-refresh happens on read (`getAuth`/actions), so all helpers work without the middleware. |
| `getAuthKitContext`, `getAuthKitContextOrNull`                                            | ⛔                  | No public accessor; a per-request session cache exists internally (one unseal/refresh per request).                                              |
| `getAuthkit`, `AuthService`                                                               | ⛔                  | WorkOS session-service factory; not applicable.                                                                                                  |
| Actions (`getAuthAction`, `refreshAuthAction`, …)                                         | ✅                  | Exported from the root **and** `./client` (plus ID-token variants); see below.                                                                   |
| `OAuthStateMismatchError`, `PKCECookieMissingError`                                       | ✅                  | Passed to `handleCallbackRoute`'s `onError` for missing-state / unknown-state failures.                                                          |
| Types: `UserInfo`, `NoUserInfo`                                                           | ✅                  | Match WorkOS field-for-field.                                                                                                                    |
| Types: `GetAuthURLOptions`                                                                | ✅ (subset)         | `{ screenHint, returnPathname, redirectUri, scope, maxAge, loginHint }`. No WorkOS-specific `organizationId`/custom `state` (state keys the PKCE cookie). |
| Types: `OauthTokens`                                                                      | ⛔                  |                                                                                                                                                  |
| Types: `User`, `Session`, `Impersonator`, `AuthResult`, `BaseTokenClaims`, `CustomClaims` | ✅                  | Real shapes (were empty `{}`).                                                                                                                   |

### Client entry (`./client`)

| WorkOS export                                                                                         | Hercules | Notes                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `AuthKitProvider`                                                                                     | ✅       | Same props (`onSessionExpired`, `initialAuth`).                                                                      |
| `useAuth(options?)`                                                                                   | ✅       | Returns user + claim fields, `loading`, `getAuth`, `refreshAuth`, `signOut`. **No `switchToOrganization`** (Tier 3). |
| `useAccessToken()`                                                                                    | ✅       | Token store with single-flight + proactive scheduled refresh and refresh-on-wake.                                    |
| `useTokenClaims<T>()`                                                                                 | ✅       | Decodes the access token in memory.                                                                                  |
| `useRecentAuth({ maxAge })`                                                                           | ✅       | From the `auth_time` claim. Presentation-only; `checkRecentAuth` (server) enforces.                                  |
| `useIdToken()`                                                                                        | ✅ (Hercules extra) | ID-token twin of `useAccessToken` over its own token store.                                                |
| `getAuthAction`                                                                                       | ✅       | Re-exported for seeding `initialAuth`.                                                                               |
| `Impersonation` component                                                                             | ⛔       | WorkOS-specific; not applicable.                                                                                     |
| Types: `AuthContextType`, `AuthKitProviderProps`, `UseAccessTokenReturn`, `JWTPayload`, `TokenClaims` | ✅       |                                                                                                                      |

**How it fits together:** `AuthKitProvider` fetches sanitized auth (no access
token) via `getAuthAction` and monitors expiry via `checkSessionAction`. The
access token is fetched separately by `useAccessToken`'s token store
(`getAccessTokenAction` / `refreshAccessTokenAction`), so it is never embedded in
the SSR'd user state. `refreshAccessTokenAction` / `refreshAuthAction` perform a
real OIDC `refresh_token` grant server-side and re-seal the session cookie.

**Bundling:** both entries keep `openid-client` and the session plumbing out of
their static import graphs. Every server body — actions, server functions
(`getAuth`, `signOut`, URL builders, `checkRecentAuth`), and the route handlers —
is reached only through a dynamic `import()` of a body module, mirroring
upstream's `action-bodies`/`server-fn-bodies`/lazy-handler pattern, so nothing
server-only can leak into the client bundle regardless of compiler DCE.

**Difference from WorkOS:** we drop the `workos-access-token` "fast cookie"
optimization (a JS-readable cookie that primes the token store on first paint).
The first access-token read does one RPC instead.

## Claim mapping

`getAuth()` builds `UserInfo` by decoding the ID token (and, best-effort, the
access token) and mapping standard OIDC claims:

| `UserInfo` / `User` field | OIDC claim                               |
| ------------------------- | ---------------------------------------- |
| `user.id`                 | `sub`                                    |
| `user.email`              | `email`                                  |
| `user.emailVerified`      | `email_verified`                         |
| `user.firstName`          | `given_name`                             |
| `user.lastName`           | `family_name`                            |
| `user.profilePictureUrl`  | `picture`                                |
| `sessionId`               | `sid`                                    |
| `organizationId`          | `org_id`                                 |
| `role`                    | `role`                                   |
| `roles`                   | `roles` (falls back to `cognito:groups`) |
| `permissions`             | `permissions`                            |
| `entitlements`            | `entitlements`                           |
| `featureFlags`            | `feature_flags`                          |
| `accessToken`             | the stored access token                  |

Org/role/permission/entitlement/feature-flag fields are only populated when the
IdP includes the corresponding (non-standard) claim. Standard providers won't
emit them unless configured to.

## Environment variables

| Variable                        | Required | Description                                                              | WorkOS equivalent        |
| ------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------ |
| `HERCULES_AUTH_ISSUER_URL`      | yes      | OIDC issuer for discovery (`{issuer}/.well-known/openid-configuration`). | —                        |
| `HERCULES_AUTH_CLIENT_ID`       | yes      | OAuth client ID.                                                         | `WORKOS_CLIENT_ID`       |
| `HERCULES_AUTH_CLIENT_SECRET`   | no       | Omit for a public (PKCE-only) client.                                    | `WORKOS_API_KEY`         |
| `HERCULES_AUTH_COOKIE_PASSWORD` | yes      | ≥32 chars. Used to seal the session cookie (AES-256-GCM).                | `WORKOS_COOKIE_PASSWORD` |
| `HERCULES_AUTH_REDIRECT_URI`    | no       | Fallback for the middleware `redirectUri` option.                        | `WORKOS_REDIRECT_URI`    |
| `HERCULES_AUTH_COOKIE_MAX_AGE`  | no       | Session cookie lifetime (seconds); default ~400 days.                    | `WORKOS_COOKIE_MAX_AGE`  |
| `HERCULES_AUTH_COOKIE_NAME`     | no       | Session cookie base name; default `hercules_session`.                    | `WORKOS_COOKIE_NAME`     |
| `HERCULES_AUTH_COOKIE_DOMAIN`   | no       | Session cookie `Domain`; default host-only.                              | `WORKOS_COOKIE_DOMAIN`   |

Each accepts alias names in order: `HERCULES_AUTH_*`, a standard OIDC alias
where one applies (`HERCULES_OIDC_AUTHORITY`, `HERCULES_OIDC_CLIENT_ID`), then
unprefixed `AUTH_*`.

## Known limitations / follow-ups

- **`handleCallbackRoute.onSuccess` payload differs** from WorkOS. Aligning it
  (deriving a `user` object, `authenticationMethod`, etc.) is a deferred Tier 1
  item.
- **No `switchToOrganization` on the client.** `useAuth()` omits it (Tier 3,
  org-specific).
- **No public per-request auth context.** Session resolution is memoized per
  request internally (one unseal + at most one refresh per request, rotation-safe),
  but there is no `getAuthKitContext`-style accessor for app server functions.
- **Verified by types/tests/build, not a live app.** The `createServerFn`
  runtime (RPC, cookie writes inside actions, the provider/hook lifecycle) should
  be smoke-tested in a consuming TanStack Start app before release.

### Resolved (previously listed here)

- **Session lifetime / refresh-token loss** — the session cookie now uses a
  long, configurable `Max-Age` (default ~400 days) decoupled from the access
  token, and expired sessions auto-refresh on any server-side read.
- **Open redirect on callback** — the post-callback `Location` is anchored to
  the callback's origin (only pathname/query/hash of `returnPathname` are used).
- **Server bundle leak risk** — all server-fn and route-handler bodies moved
  behind dynamic imports (previously only the client actions were).
