---
"@usehercules/vite": patch
---

Create placeholder stubs for missing `.tsx` imports atomically. The stub is written to a temporary file and hard-linked into place, so it appears whole or not at all and can no longer overwrite the start of a component file that another process writes at the same moment.
