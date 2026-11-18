---
"@usehercules/auth-tanstack": patch
---

Fix sign-in failing on Cloudflare Workers after a cancelled first request. The OIDC discovery result is now shared across requests only once it has resolved, so each request runs its own discovery until one succeeds. Before, a pending discovery was shared, and when the first request on an isolate was cancelled mid-discovery, every later sign-in, callback, and refresh on that isolate failed until the isolate restarted.
