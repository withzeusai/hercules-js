---
"@usehercules/auth": patch
---

Fix Convex provider reporting `isLoading` as `true` when `isAuthenticated` is already `true`, preventing unnecessary loading states. Skip token refresh when the current token won't expire within the next hour.
