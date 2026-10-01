---
"@usehercules/auth": patch
---

Sign out locally when the app runs inside an iframe, such as the App Builder preview, instead of navigating the frame to the hosted sign-out page, which refuses to be framed. Token revocation configured with `revokeTokensOnSignout` still runs. Top-level sign-out is unchanged.
