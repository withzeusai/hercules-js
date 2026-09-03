# @usehercules/auth-tanstack

## 0.6.0

### Minor Changes

- [#138](https://github.com/withzeusai/hercules-js/pull/138) [`e4c8501`](https://github.com/withzeusai/hercules-js/commit/e4c85011cb1fa83841765a2550d7658ecf1f56ac) Thanks [@grant0417](https://github.com/grant0417)! - Add `@usehercules/auth-tanstack/convex`, a Convex auth bridge that waits for a
  token before reporting authenticated.

  `ConvexProviderWithAuth` requests a token when the object returned by its
  `useAuth` prop changes identity, and not otherwise. Apps have been wiring this
  up by hand with `isAuthenticated = user !== null`, which is true from the first
  client render because the provider is seeded with `initialAuth` during SSR --
  before the token store has fetched anything. Convex therefore spent its single
  request on a cold store, and when that request came back empty the client
  stayed unauthenticated for the life of the page, even once a valid token
  arrived. `ctx.auth.getUserIdentity()` returned `null` for every query on that
  connection while the ID token was provably valid.

  `ConvexProviderWithHerculesAuth` derives `isAuthenticated` from the ID token
  rather than the session, so the object's identity changes when the token lands
  and Convex asks again. It also resolves `null` instead of rejecting when a
  token fetch fails, since a rejection latches the same way.

- [#144](https://github.com/withzeusai/hercules-js/pull/144) [`e79d600`](https://github.com/withzeusai/hercules-js/commit/e79d60063b2bb6044ad2571262e1b0e5da03d8db) Thanks [@grant0417](https://github.com/grant0417)! - Keep sessions authenticated when no refresh token was issued.

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

### Patch Changes

- [#136](https://github.com/withzeusai/hercules-js/pull/136) [`f97c080`](https://github.com/withzeusai/hercules-js/commit/f97c080d647b4e4849efb1fc18628cd8d1b85458) Thanks [@grant0417](https://github.com/grant0417)! - Fix sign-out stranding users on the provider's signed-out page.

  The post-sign-out target was built as `new URL(returnTo ?? "/", origin)`, which
  renders the app root as `https://app.example.com/`. Providers register that root
  as the bare origin, and OIDC RP-Initiated Logout 1.0 §3 has the OP compare
  `post_logout_redirect_uri` to its registered list by simple string comparison
  and refuse to redirect on a miss. The trailing slash was therefore enough to end
  every sign-out on the provider's own page rather than back in the app, with no
  error the app could see. `@usehercules/auth` was unaffected -- it sends
  `window.location.origin`.

  - Resolve the value through a single `resolvePostLogoutRedirectUri`, which spells
    a root target as the bare origin and is shared by the `signOut` server function
    and the `getSignOutUrl` action behind the React `signOut()`.
  - Add a `postLogoutRedirectUri` middleware option (and
    `HERCULES_AUTH_POST_LOGOUT_REDIRECT_URI`) for apps whose registered URI is not
    their own origin. An absolute value is sent verbatim, so an app whose provider
    registered the trailing-slash form can still spell it.
  - Stop the client `signOut()` defaulting `returnTo` to `"/"`. An explicit value
    overrode the configured one, so the new option would never have applied to the
    hook.
  - Anchor `returnTo` to the app's origin, as the post-callback redirect already
    is. An off-origin value used to pass straight through to the browser on the
    paths that skip the provider -- no end-session endpoint, or discovery failing.
  - Skip the provider when there is no session, matching WorkOS's AuthKit. There
    is nothing to end, and an end-session request with no `id_token_hint` makes the
    OP interrupt with its own confirmation page, so a user whose session had
    already lapsed was asked to confirm signing out of nothing. The cookie clear
    still runs.

## 0.5.0

### Minor Changes

- [#135](https://github.com/withzeusai/hercules-js/pull/135) [`c74a916`](https://github.com/withzeusai/hercules-js/commit/c74a9162a9250c7c956691e379e924a9c2967944) Thanks [@grant0417](https://github.com/grant0417)! - Always-array permission claims: `roles`, `permissions`, `entitlements`, and
  `featureFlags` are now typed `string[]` (never `undefined`) on `UserInfo`,
  `ClientUserInfo`, and the `useAuth()` context, defaulting to `[]` when the
  claim is absent or the user is signed out. Scalar claims (`role`,
  `organizationId`) and the raw JWT payload types are unchanged.

## 0.4.0

### Minor Changes

- [#99](https://github.com/withzeusai/hercules-js/pull/99) [`193c31f`](https://github.com/withzeusai/hercules-js/commit/193c31f0ae4ad4fc8284c58459c2c3797d00a64c) Thanks [@grant0417](https://github.com/grant0417)! - Close functional gaps against upstream `@workos/authkit-tanstack-react-start`:

  - **Sessions survive access-token expiry.** The session cookie now uses a long, configurable `Max-Age` (default ~400 days; `HERCULES_AUTH_COOKIE_MAX_AGE` / `cookieMaxAge`) instead of the access token's lifetime, and any server-side read (`getAuth`, hook actions) transparently refreshes an expired session with the sealed refresh token. Session resolution is memoized per request and rotation-safe (a second refresh in the same request uses the rotated refresh token).
  - **Server code can no longer leak into the client bundle.** All server-function and route-handler bodies are loaded via dynamic import; the root barrel's static import graph no longer reaches `openid-client`.
  - **Recent-auth enforcement.** New `checkRecentAuth({ maxAge })` server function (the enforcement half of `useRecentAuth`), and `maxAge`/`loginHint` options on `getSignInUrl`/`getSignUpUrl`/`getAuthorizationUrl`/`handleSignInRoute` forwarded as OIDC `max_age`/`login_hint`.
  - **Callback hardening.** The post-callback redirect is anchored to the callback's origin (closes an open redirect via `returnPathname`); `onError` responses get the failed flow's verifier-delete cookies appended; a missing `code` evicts the flow's verifier; missing/unknown `state` surfaces typed `OAuthStateMismatchError`/`PKCECookieMissingError`.
  - **New config knobs.** `HERCULES_AUTH_REDIRECT_URI` env fallback for the middleware `redirectUri`, plus session cookie name/domain overrides (`HERCULES_AUTH_COOKIE_NAME`, `HERCULES_AUTH_COOKIE_DOMAIN` / `cookieDomain`).
  - **Expanded exports.** Root entry now exports the hook-backing actions (`checkSessionAction`, `getAccessTokenAction`, `refreshAccessTokenAction`, `getIdTokenAction`, `refreshIdTokenAction`, `refreshAuthAction`), the typed errors, and `ClientUserInfo`/`SignInUrlOptions`/`RecentAuthResult` types.
  - **Client polish.** `useAuth({ ensureSignedIn: true })` narrows `user` to non-null once `loading` is false; the token store skips redundant notifications when a silent revalidation returns an unchanged token.

## 0.3.0

### Minor Changes

- [#88](https://github.com/withzeusai/hercules-js/pull/88) [`22addb0`](https://github.com/withzeusai/hercules-js/commit/22addb0acbfcef1c9c6b53beb6688c3f8c08f0d4) Thanks [@grant0417](https://github.com/grant0417)! - Add `herculesAuthMiddleware` and fix auth cookies behind a TLS-terminating proxy and in cross-site (embedded) contexts.

  - **`herculesAuthMiddleware({ redirectUri, cookieSameSite })`**: a new request middleware that configures the SDK app-wide.
    - `redirectUri` — the public callback URL (e.g. `https://app.example.com/auth/callback`). Behind a TLS-terminating proxy, `request.url` only reflects the internal `http://` hop, so cookies were written without `Secure` and `redirect_uri` was built with the wrong origin. Configuring `redirectUri` makes the SDK derive the real origin/protocol from it (it also becomes the default `redirect_uri` sent to the provider). Falls back to `request.url` when unset. `secure` fails closed to `true` when no valid URL is available.
    - `cookieSameSite` — override the SameSite attribute for the PKCE verifier and session cookies. Defaults to protocol-derived: `none` over HTTPS (so the cookies can be set/sent when the app is embedded cross-site, e.g. in an iframe) and `lax` over HTTP (local dev). `none` always implies `Secure`. This fixes the PKCE verifier cookie being blocked with `SameSite=Lax` on the server-function sign-in path.
  - The callback now reconstructs the resolved public callback URL before exchanging the code, so the token request's `redirect_uri` matches the authorization request's even behind a TLS-terminating proxy (where `request.url` is only the internal hop). Previously the exchange used the internal URL and providers that pin `redirect_uri` rejected the callback with a mismatch. The `redirect_uri` used at sign-in (including a per-request `redirectUri` override) is sealed into the PKCE cookie and replayed at the exchange, so overrides that differ from the app-wide config are honored too.
  - Verifier-cookie deletion now emits both `Lax` and `None; Secure` variants so the cookie clears regardless of how it was set.
  - The default callback path is now `/auth/callback` (previously `/api/auth/callback`). Apps that mount the callback route at the old path should either move it to `/auth/callback` or pass an explicit `redirectUri` (on `herculesAuthMiddleware`, `handleSignInRoute`, or the sign-in URL helpers).

## 0.2.0

### Minor Changes

- [`ad6f2bd`](https://github.com/withzeusai/hercules-js/commit/ad6f2bda2021ca40c2c4d34e8482ceec1a491250) Thanks [@grant0417](https://github.com/grant0417)! - Add a `useIdToken` client hook and additional environment-variable fallbacks.

  - **`useIdToken`** (`@usehercules/auth-tanstack/client`): manage the OIDC ID token with the same fetch/refresh lifecycle as `useAccessToken` (single-flight refresh, proactive refresh ahead of expiry, refresh on tab wake). Returns `{ idToken, loading, error, refresh, getIdToken }`. `idToken` is `undefined` when the provider issued none. Exports the `UseIdTokenReturn` type. Backed by new `getIdTokenAction`/`refreshIdTokenAction` server functions.
  - **Environment variables**: each setting now accepts several names, tried in order. The issuer also reads `HERCULES_OIDC_AUTHORITY` and the client ID `HERCULES_OIDC_CLIENT_ID`; in addition, every value falls back to its unprefixed `AUTH_*` name last (`AUTH_ISSUER_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_COOKIE_PASSWORD`). The canonical `HERCULES_AUTH_*` names keep precedence, so existing configuration is unaffected.

## 0.1.0

### Minor Changes

- [#83](https://github.com/withzeusai/hercules-js/pull/83) [`b59322c`](https://github.com/withzeusai/hercules-js/commit/b59322cac73f39a71728d6bef09c5cba3e56fb80) Thanks [@grant0417](https://github.com/grant0417)! - Add a session layer, server functions, and client hooks for OIDC auth with TanStack Start.

  - **Session**: tokens are sealed (AES-256-GCM) into a chunked `hercules_session` cookie holding the access, ID, and refresh tokens. Requires `HERCULES_AUTH_COOKIE_PASSWORD` (≥32 chars).
  - **Server functions** (main entry): `getAuth`, `signOut`, `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`. `handleCallbackRoute` now writes the sealed session and honors a `returnPathname` carried through the PKCE cookie.
  - **Types**: real `User`, `Session`, `UserInfo`, `NoUserInfo`, `BaseTokenClaims`, `CustomClaims` (previously empty), plus `GetAuthURLOptions`.
  - **Client entry (`@usehercules/auth-tanstack/client`)**: `HerculesAuthProvider`, `useAuth`, `useAccessToken`, `useTokenClaims`, `useRecentAuth`, backed by RPC actions that perform an OIDC `refresh_token` grant and re-seal the session. Adds `react` as a peer dependency.
  - **Concurrent sign-in**: the PKCE verifier cookie is keyed by state (`hercules_pkce_<state>`) so overlapping sign-in flows in the same browser no longer clobber each other; surplus pending verifier cookies are evicted to bound the request `Cookie` header.

## 0.0.1

### Patch Changes

- [#82](https://github.com/withzeusai/hercules-js/pull/82) [`63ce953`](https://github.com/withzeusai/hercules-js/commit/63ce9536680daedace91163ec1829b401c0f6aed) Thanks [@grant0417](https://github.com/grant0417)! - Initial release of `@usehercules/auth-tanstack`: TanStack server route handlers
  for the OIDC Authorization Code + PKCE flow. `handleSignInRoute` initiates login
  (generating PKCE and `state`, then redirecting to the provider), and
  `handleCallbackRoute` completes the token exchange, sets the session cookie, and
  redirects home. Provider configuration is read from the `HERCULES_AUTH_ISSUER_URL`,
  `HERCULES_AUTH_CLIENT_ID`, and (optional) `HERCULES_AUTH_CLIENT_SECRET` environment
  variables.
