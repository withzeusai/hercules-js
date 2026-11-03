---
"@usehercules/auth": patch
---

`ConvexProviderWithHerculesAuth` now retries a token renewal that fails for a transient reason, such as a dropped connection, a timeout, a 5xx, or the browser being offline, instead of handing Convex a null token. Convex reads null as signed out and does not ask again, so a brief network drop, like a laptop waking from sleep, used to sign the user out of Convex until the page reloaded. It retries twice with a short backoff, and while offline waits for the browser's `online` event. An OAuth error such as `invalid_grant`, or any other 4xx, still ends the session immediately.
