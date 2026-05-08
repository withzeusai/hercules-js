---
"@usehercules/auth": patch
---

Re-enable forced token refresh in `ConvexProviderWithHerculesAuth` so Convex
can recover after a 401 instead of getting the same expired id token back.
Concurrent refresh requests share a single in-flight `signinSilent` call to
avoid the React 19 strict-mode duplicate-refresh race that motivated the
original disable.
