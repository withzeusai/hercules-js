---
"@usehercules/vite-tanstack": patch
---

Turn off `@usehercules/vite`'s new dependency pre-bundling inside the stack, since `hercules:prebundle-dependencies` already covers the browser and the Worker, and drop `prebundleDependencies` from the `hercules` option's type. The package no longer publishes its `src` directory.
