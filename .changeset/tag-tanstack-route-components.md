---
"@usehercules/vite": patch
---

Tag JSX in TanStack Router route components. The code splitter loads them from `?tsr-split` and `?tsr-shared` virtual modules, which the component tagger skipped, so the visual editor could not select anything on a TanStack Start page.
