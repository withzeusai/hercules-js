---
"@usehercules/auth": patch
---

Restart sign-in once when `useAuthCallback` receives a callback whose OIDC state is missing from this browser, such as an email verification link opened in a different browser or in-app webview. The orphaned code is dropped from the URL and never redeemed. A second missing-state failure in the same tab shows the existing error screen.
