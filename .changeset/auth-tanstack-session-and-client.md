---
"@usehercules/auth-tanstack": minor
---

Add a session layer, server functions, and client hooks for OIDC auth with TanStack Start.

- **Session**: tokens are sealed (AES-256-GCM) into a chunked `hercules_session` cookie holding the access, ID, and refresh tokens. Requires `HERCULES_AUTH_COOKIE_PASSWORD` (≥32 chars).
- **Server functions** (main entry): `getAuth`, `signOut`, `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`. `handleCallbackRoute` now writes the sealed session and honors a `returnPathname` carried through the PKCE cookie.
- **Types**: real `User`, `Session`, `UserInfo`, `NoUserInfo`, `BaseTokenClaims`, `CustomClaims` (previously empty), plus `GetAuthURLOptions`.
- **Client entry (`@usehercules/auth-tanstack/client`)**: `HerculesAuthProvider`, `useAuth`, `useAccessToken`, `useTokenClaims`, `useRecentAuth`, backed by RPC actions that perform an OIDC `refresh_token` grant and re-seal the session. Adds `react` as a peer dependency.
- **Concurrent sign-in**: the PKCE verifier cookie is keyed by state (`hercules_pkce_<state>`) so overlapping sign-in flows in the same browser no longer clobber each other; surplus pending verifier cookies are evicted to bound the request `Cookie` header.
