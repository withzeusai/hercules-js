---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Leave source files that import Vite or a Vite plugin, such as a Node prerender script, out of the dependency optimizer's source scan. Scanned as an entry, such a script made Vite bundle the build toolchain and its native binaries for the browser, which failed every dev server start.
