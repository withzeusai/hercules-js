---
"@usehercules/vite-tanstack": patch
---

Leave `@tanstack/devtools-vite` out of `vite dev` on the Hercules dev machine unless `devtools` is set. The template never renders the devtools panel, so the plugin only added a transform to every module, about 15% of the first render. Builds keep it.
