---
"@usehercules/vite": patch
---

Show an error page that reloads itself when server rendering fails in dev. When a TanStack Start page threw something other than a `Response`, the dev server answered with Start's raw JSON 500, `{"status":500,"statusText":"","unhandled":true,"message":"HTTPError"}`, which the preview showed as text and never left on its own. Page loads that get this response now see a short HTML error page with the same status instead. It loads the Vite client, so the next file change reloads it, and polls its own URL every one to five seconds, reloading once the page renders again. Other responses, including the app's own HTML error pages and streamed pages, are passed through unchanged.
