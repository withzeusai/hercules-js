---
"@usehercules/auth": patch
---

Fix `ConvexProviderWithHerculesAuth` reusing a still-valid id_token on forced refresh instead of rotating on every call.

`REFRESH_THRESHOLD_MS` was `60 * 60 * 1000` (one hour), exactly equal to the platform id_token lifetime. `tokenExpiresWithin(token, ms)` returns `exp*1000 - now < ms`, so for a token minted with a one-hour life, `tokenExpiresWithin(token, 3_600_000)` reduces to `iat*1000 < now`, which is always true. Both reuse fast paths in `fetchAccessToken` (the top-level check and the in-lock recheck) were therefore dead, so every `fetchAccessToken({ forceRefreshToken: true })` fell through to `signinSilent()` and rotated the refresh token.

Because Hercules Auth (Better Auth) rotates refresh tokens with replay detection that deletes the entire token family, concurrent contexts that do not share the `__herculesAuthRefresh` lock (a cross-origin editor-preview iframe, or any browser without `navigator.locks`) each rotated in parallel; the loser's next rotation was treated as a replay, the family was revoked, `signinSilent()` threw, and Convex reported the user signed out ("authentication timed out" / bounce to the landing page).

Lowering the threshold to `5 * 60 * 1000` (five minutes) makes the reuse fast paths reachable again: a context holding an id_token with more than five minutes of life returns it directly instead of rotating, so concurrent contexts stop contending for the rotating refresh token. The refresh path (and `signinSilent()`) still runs once a token is within five minutes of expiry.

The swallowed rotation failure in the in-lock `catch` now logs via `console.error` before returning `null`; the return contract is unchanged.
