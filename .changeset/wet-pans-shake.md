---
"@usehercules/auth-tanstack": minor
---

Always-array permission claims: `roles`, `permissions`, `entitlements`, and
`featureFlags` are now typed `string[]` (never `undefined`) on `UserInfo`,
`ClientUserInfo`, and the `useAuth()` context, defaulting to `[]` when the
claim is absent or the user is signed out. Scalar claims (`role`,
`organizationId`) and the raw JWT payload types are unchanged.
