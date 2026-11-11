---
"@usehercules/auth": patch
---

Retry the session renewal that `HerculesAuthProvider` runs when an app opens with an expired sign-in, when it fails for a transient reason such as a dropped connection, a timeout, a 5xx, or the browser being offline. It is the only renewal an expired user gets, so one failure, common when a phone reopens an app before its network is back, showed the app as signed out even though the saved refresh token was still valid. It retries twice with a short backoff, the same policy `ConvexProviderWithHerculesAuth` already uses. An OAuth error such as `invalid_grant` still ends the session immediately.
