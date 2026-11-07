---
"@usehercules/vite-tanstack": patch
---

Leave files that import `@react-three/*` out of the devtools source injection. React Three Fiber read the injected `data-tsd-source` prop as a nested property, so after an edit shifted lines it threw `Cannot set "data-tsd-source"` and the canvas crashed.
