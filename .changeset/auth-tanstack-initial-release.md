---
"@usehercules/auth-tanstack": patch
---

Initial release of `@usehercules/auth-tanstack`: TanStack server route handlers
for the OIDC Authorization Code + PKCE flow. `handleSignInRoute` initiates login
(generating PKCE and `state`, then redirecting to the provider), and
`handleCallbackRoute` completes the token exchange, sets the session cookie, and
redirects home. Provider configuration is read from the `HERCULES_AUTH_ISSUER_URL`,
`HERCULES_AUTH_CLIENT_ID`, and (optional) `HERCULES_AUTH_CLIENT_SECRET` environment
variables.
