---
"@usehercules/vite-tanstack": patch
---

Show an HTML error page in dev when a page keeps failing outside the router. TanStack Start answers an error thrown in request middleware, `getRouter`, or a route tree that fails to import with a bare JSON body (`{"status":500,"statusText":"","unhandled":true,"message":"HTTPError"}`), so the Hercules preview could not add its scripts to the page, and the error itself appeared only in the dev server log. Once the same page has failed for 4 seconds since the Worker last reloaded, the dev server now answers with a page that shows the error the Worker logged, reports it to the preview as `[Vite Server Error]`, and reloads when the Worker reloads. Shorter failures, fetches such as server functions, and every other response are unchanged, and production builds are not affected.
