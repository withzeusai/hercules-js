---
"@usehercules/auth": patch
---

Keep a still-valid, server-checked ID token after a transient silent-renewal failure, and reconnect Convex when a later renewal supplies a new valid token. Expired tokens and permanent authentication errors still fail closed.
