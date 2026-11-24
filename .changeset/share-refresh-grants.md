---
"@usehercules/auth-tanstack": patch
---

Spend a refresh token once when several server requests refresh the same expired session together. A page that preloads routes or calls server functions in parallel sends the same expired cookie with each request, and each request used to run its own refresh grant, dozens for one page view. The authorization server rate-limited that, and other sign-ins could fail with "Token exchange failed" while the limit lasted. Requests that present the same refresh token in one server instance now share one grant, and for 10 seconds afterward the result also answers requests that still carry the old cookie. A request that waits more than 10 seconds on another request's grant runs its own.
