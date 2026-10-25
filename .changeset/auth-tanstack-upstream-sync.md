---
"@usehercules/auth-tanstack": patch
---

Keep tokens fresh when the browser clock is wrong, and refresh once for both tokens.

- The access-token and ID-token stores now share one read and one refresh. Their tokens usually expire together, so each refreshed with the same refresh token at the same moment; a provider that rotates refresh tokens with reuse detection revokes the session for that.
- Token expiry is judged on the server's clock. A browser clock running more than about a minute behind made the store hand out expired ID tokens, which left Convex unauthenticated for the rest of the page. A clock running ahead by roughly a token lifetime made every token look expired and spent a refresh grant every 15 seconds. `useRecentAuth` also uses the server's clock.
- `useRecentAuth` reads `auth_time` from the ID token first, as `checkRecentAuth` does, and falls back to the access token. It previously read only the access token, which many providers issue without `auth_time`, so it reported every sign-in as stale.
- An `onSuccess` that throws in `handleCallbackRoute` now fails the sign-in through `onError` or `errorRedirectUrl`, clears the flow's verifier cookie, and sets no session. Previously the error escaped as a bare 500.
- When more than 10 sign-ins are pending, the oldest verifier cookies are expired instead of the newest.
- A `returnPathname` too long to fit in the verifier cookie is dropped with a warning, instead of the browser discarding the cookie and the callback failing.
- A rate-limited (HTTP 429) refresh is retried once after `Retry-After`, capped at 5 seconds.
- A token request rejected with `invalid_client` while no client secret is configured logs a hint naming `HERCULES_AUTH_CLIENT_SECRET`.
- The package now ships a `LICENSE`, including the MIT notice for the portions derived from WorkOS AuthKit.
