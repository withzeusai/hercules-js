---
"@usehercules/auth-tanstack": minor
---

Require an explicit sign-in and stop framed sign-out from breaking the app.

- Every authorization request now sends OIDC `prompt=login`. The provider keeps its own single-sign-on session, so a sign-in previously returned whichever account was already signed in there without asking. `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`, and `handleSignInRoute` accept a new `prompt` option to override it (`select_account`, `consent`, `none`), or an empty string to send no `prompt`. `maxAge` is unchanged and can be combined with it.
- `useAuth().signOut()` inside an iframe, such as the App Builder preview, no longer navigates the frame to the hosted end-session page, which refuses to be framed. Framed apps send the end-session request in the background and navigate to their own post-logout destination. Top-level sign-out is unchanged.
