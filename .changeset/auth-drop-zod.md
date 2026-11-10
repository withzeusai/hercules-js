---
"@usehercules/auth": patch
---

Drop the `zod` dependency. `useAuthCallback` used it for one check, reading the `message` string from a `ConvexError`, and the namespace import pulled about 25 KB gzipped of zod into every app's first page load. A plain type check now does the same job.
