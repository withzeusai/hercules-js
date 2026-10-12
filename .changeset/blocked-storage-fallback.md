---
"@usehercules/auth": patch
---

Stop `HerculesAuthProvider` from crashing with `SecurityError: The operation is insecure.` when the browser blocks `localStorage`, such as in a third-party iframe with third-party cookies blocked. The provider now falls back to `sessionStorage`, where sign-in still completes, and then to in-memory storage, where the app renders but a redirect sign-in cannot complete in that frame. Behavior is unchanged when `localStorage` is available, and a `userStore` or `stateStore` you pass is still used as is.
