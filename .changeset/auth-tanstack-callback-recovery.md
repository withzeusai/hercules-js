---
"@usehercules/auth-tanstack": minor
---

Send users back into the app when a sign-in callback fails in a way they can recover from, instead of showing a raw JSON error.

- Cancelling at the provider, a sign-in older than 10 minutes, a reloaded or bookmarked `/auth/callback`, a sign-in evicted by too many pending ones, and a missing `code` or `state` used to answer with a 400 such as `{"error":"Unknown or expired sign-in state"}`. `handleCallbackRoute` now redirects to the page the sign-in started from (its `returnPathname`, anchored to the app's origin), or `/` when that is unknown, and appends `?auth_error=<reason>`: `access_denied`, `provider_error`, `invalid_callback`, or `sign_in_expired`. A provider `error` response is reported as such rather than as a missing code. `onError` and `errorRedirectUrl` still take precedence, and `onError` now also receives the `reason` and the flow's `returnPathname`. A failed token exchange or session seal still answers with a JSON 500.
- A PKCE cookie that cannot be decoded is treated like an expired one, before the token exchange, instead of falling through to "Token exchange failed" (500). Bare-verifier cookies are no longer accepted; none have been written since the per-flow cookies were introduced, and they expire after 10 minutes.
- The client bundle no longer contains the route handlers' server code. The dynamic `import()` behind `handleSignInRoute` and `handleCallbackRoute` left the bundler emitting a 35 KB chunk with `openid-client` and the session plumbing into the browser assets, even though nothing loaded it. The loader is now a `createServerOnlyFn`, which TanStack Start's compiler stubs out of the client build.
- New exports: `AUTH_ERROR_PARAM`, `OAuthProviderError`, and the `CallbackErrorReason` and `CallbackErrorParams` types.
