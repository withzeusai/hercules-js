---
"@usehercules/auth": patch
---

Show a minimal loading spinner while `HerculesAuthProvider` restores an expired session, instead of a blank page. Pass `loadingFallback` to render your own UI, or `loadingFallback={null}` to keep the previous behavior.
