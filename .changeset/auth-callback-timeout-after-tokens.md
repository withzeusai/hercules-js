---
"@usehercules/auth": patch
---

Give `useAuthCallback` at least 60 seconds for each step after the sign-in tokens are saved: waiting for the backend, such as Convex, to accept the token, and running `onSync`. Each step previously got the same 20 second `timeoutMs` as the token exchange, so a slow Convex connection, which happens on Safari, showed "Authentication timed out" even though sign-in had already succeeded. The token exchange still times out after `timeoutMs`, and a `timeoutMs` above 60 seconds still applies to every step.
