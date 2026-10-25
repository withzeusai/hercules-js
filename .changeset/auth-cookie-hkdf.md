---
"@usehercules/auth-tanstack": minor
---

Derive the session-cookie key from `HERCULES_AUTH_COOKIE_PASSWORD` with HKDF instead of 100,000 rounds of PBKDF2, which cost about 11 ms of CPU on every cold start (Node, desktop CPU) against well under 1 ms now. The password must be random (Hercules sets one per app), since it is no longer stretched. The derived key is cached per password value, so a changed password takes effect without a restart. Sessions sealed by earlier versions no longer unseal, so upgrading signs users out once.
