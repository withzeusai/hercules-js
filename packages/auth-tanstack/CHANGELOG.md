# @usehercules/auth-tanstack

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
