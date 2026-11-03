---
"@usehercules/vite-tanstack": patch
---

Show an HTML error page in dev when a page keeps failing outside the router. TanStack Start answers an error thrown in request middleware, `getRouter`, or a failed route tree import with a bare JSON body, which the Hercules preview cannot add its scripts to. Once the same page has failed for 4 seconds since the Worker last reloaded, the dev server answers with a page that shows the error the Worker logged, reports it to the preview as `[Vite Server Error]`, and reloads when the Worker reloads. Shorter failures, fetches, every other response, and production builds are unchanged.
