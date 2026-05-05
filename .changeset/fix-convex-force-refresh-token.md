---
"@usehercules/auth": patch
---

Honor `forceRefreshToken` in the Convex auth bridge so Convex can recover when its access token expires. Previously the flag was ignored and the same stale id_token was returned, which caused end users on idle sessions (especially backgrounded PWAs on iOS) to be silently signed out after the access token expired even though the refresh token was still valid. `signinSilent()` is now called when `forceRefreshToken` is true, mirroring the pre-1.0.41 behavior that was accidentally commented out during the React 19 / Convex 1.29 upgrade.
