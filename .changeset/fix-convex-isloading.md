---
"@usehercules/auth": patch
---

Fix Convex provider reporting `isLoading` as `true` when `isAuthenticated` is already `true`, preventing unnecessary loading states.
