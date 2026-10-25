---
"@usehercules/vite-tanstack": patch
---

Turn the dev machine settings (`strictPort`, the watch ignores for agent-managed directories, and `awaitWriteFinish`) on when `HERCULES_DEV_MACHINE=1`, which the Hercules dev machine image sets and herculesd passes on to the dev server. They were gated on `HERCULES_DEV_SERVER=true` alone, which nothing on the platform sets, so they never turned on. `HERCULES_DEV_SERVER=true` still works as an alternate trigger.

Pre-bundle every Base UI component entry when the app declares `@base-ui/react`: each one (`@base-ui/react/dialog`, ...) is its own optimizer entry, read from the package's export map minus `./internals/*`, so the first component the app imports no longer triggers a re-bundle and a full reload. `@shadcn/react/message-scroller` joins `PREBUNDLED_ENTRIES`.

Turn on `resolve.tsconfigPaths` in the Vite and Vitest configs, next to the `@` and `@/convex` aliases, so any other `paths` the app adds to `tsconfig.json` resolve as well (Vite 8).
