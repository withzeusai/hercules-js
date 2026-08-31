---
"@usehercules/auth": patch
---

Keep a still-valid, server-checked ID token after a transient silent-renewal failure, and reconnect Convex when a later renewal supplies a new valid token. Expired tokens and permanent authentication errors still fail closed.

Report permanent errors from Convex-triggered renewal directly through provider state so application error listeners cannot suppress them or publish them after a later successful renewal.
