---
"@usehercules/vite-tanstack": patch
---

Recover server rendering in dev when a file is created after an import of it failed. When code imported a file that did not exist yet, the Worker kept the failed import after the file was written, and every page answered `{"status":500,"statusText":"","unhandled":true,"message":"HTTPError"}` until the importing file changed again. The next file created now re-transforms the importer and reloads the Worker.
