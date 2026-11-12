---
"@usehercules/vite-tanstack": patch
---

Stop the dev server from failing every page with "Duplicate routes found with id" after a route file is turned into a folder, such as `routes/feria.tsx` replaced by `routes/feria/index.tsx`. The route tree imports routes without their extension, so a page requested in the moment between deleting `feria.tsx` and TanStack Router rewriting the route tree resolved `./routes/feria` to `routes/feria/index.tsx`, and the index route became its own child. The rewritten tree did not undo that, so every page answered 500 until the dev server restarted. The route tree's imports now resolve to route files only; the stale import fails like any missing file, and the rewritten tree loads cleanly.
