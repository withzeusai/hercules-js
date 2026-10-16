---
"@usehercules/vite": patch
---

Take element ids' line and column from the file on disk when an earlier plugin changed the code. TanStack devtools (listed before `hercules()` in the TanStack Start template) adds a `data-tsd-source` attribute to every opening tag, so each element after the first on a line got a column too far right, and the visual editor failed with "Component not found" when it saved a text or class change to that element.
