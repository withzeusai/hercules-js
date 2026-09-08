---
"@usehercules/vite": patch
---

Inject the dev-only error handler and visual editor scripts through Vite's own dev client (`/@vite/client`) in addition to `transformIndexHtml`.

Server-rendered apps such as TanStack Start never call `transformIndexHtml`, so neither script reached the page and the Hercules editor and error forwarding silently did nothing there. Both scripts are now also imported from `vite/dist/client/client.mjs`, which every dev page loads, and each guards against installing twice so SPA apps that receive the index.html tag as well still run them once.
