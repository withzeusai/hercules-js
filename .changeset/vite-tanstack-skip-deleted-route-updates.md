---
"@usehercules/vite-tanstack": patch
---

Stop reporting a deleted route file as a bug in the Hercules preview. Vite handled a deleted file like an edited one: the browser was told to import the route again and logged "[vite] Failed to reload" and "[vite] Internal Server Error ENOENT", and the Worker reloaded with the old route tree and logged "Failed to load url /src/routes/... in routeTree.gen.ts", all in the second before TanStack Router rewrote the route tree and reloaded the page. On Hercules dev machines this came up whenever the agent removed a route or moved the home page under a layout, and was about 30% of the preview's automatic reloads on November 8. A deleted file that only the route tree imports now gets no update; one that other modules still import is left to Vite, so the broken import still shows.
