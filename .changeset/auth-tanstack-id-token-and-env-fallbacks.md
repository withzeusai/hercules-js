---
"@usehercules/auth-tanstack": minor
---

Add a `useIdToken` client hook and additional environment-variable fallbacks.

- **`useIdToken`** (`@usehercules/auth-tanstack/client`): manage the OIDC ID token with the same fetch/refresh lifecycle as `useAccessToken` (single-flight refresh, proactive refresh ahead of expiry, refresh on tab wake). Returns `{ idToken, loading, error, refresh, getIdToken }`. `idToken` is `undefined` when the provider issued none. Exports the `UseIdTokenReturn` type. Backed by new `getIdTokenAction`/`refreshIdTokenAction` server functions.
- **Environment variables**: each setting now accepts several names, tried in order. The issuer also reads `HERCULES_OIDC_AUTHORITY` and the client ID `HERCULES_OIDC_CLIENT_ID`; in addition, every value falls back to its unprefixed `AUTH_*` name last (`AUTH_ISSUER_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_COOKIE_PASSWORD`). The canonical `HERCULES_AUTH_*` names keep precedence, so existing configuration is unaffected.
