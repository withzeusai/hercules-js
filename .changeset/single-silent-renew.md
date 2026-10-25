---
"@usehercules/auth": patch
---

Start `automaticSilentRenew: true` renewal when `HerculesAuthProvider` mounts and stop it when it unmounts. Under React Strict Mode the provider's initializer runs twice, and both `UserManager` instances started renewing with the same refresh token.
