# @usehercules/auth-tanstack

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
