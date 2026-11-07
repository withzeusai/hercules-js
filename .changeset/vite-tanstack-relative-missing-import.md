---
"@usehercules/vite-tanstack": patch
---

Recover server rendering in dev when a file is created after a relative import of it failed. 1.0.1 recovered only from bare and aliased imports (`@/components/x`). A relative import (`./-lib/filters.ts`) failed with a different error, so the Worker kept answering `{"status":500,"unhandled":true,"message":"HTTPError"}` on every page after the file was written, until the importing file changed again or the dev server restarted. The next file created now re-transforms the importer and reloads the Worker for relative imports too.
