# @usehercules/auth-tanstack

## 0.0.1

### Patch Changes

- [#82](https://github.com/withzeusai/hercules-js/pull/82) [`63ce953`](https://github.com/withzeusai/hercules-js/commit/63ce9536680daedace91163ec1829b401c0f6aed) Thanks [@grant0417](https://github.com/grant0417)! - Initial release of `@usehercules/auth-tanstack`: TanStack server route handlers
  for the OIDC Authorization Code + PKCE flow. `handleSignInRoute` initiates login
  (generating PKCE and `state`, then redirecting to the provider), and
  `handleCallbackRoute` completes the token exchange, sets the session cookie, and
  redirects home. Provider configuration is read from the `HERCULES_AUTH_ISSUER_URL`,
  `HERCULES_AUTH_CLIENT_ID`, and (optional) `HERCULES_AUTH_CLIENT_SECRET` environment
  variables.
