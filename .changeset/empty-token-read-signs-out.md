---
"@usehercules/auth-tanstack": patch
---

`HerculesAuthProvider` now notices a session that ends while the tab is in use, not only when the tab regains focus. When a token read comes back empty while a user is shown (the session expired, was revoked, or no longer unseals after a cookie password rotation), the provider runs the same session check it runs on focus, and if the server confirms there is no session it moves to signed out and calls `onSessionExpired` (or reloads). Before, the page kept showing the user while their tokens were gone.
