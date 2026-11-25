---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Fix the dev server exiting when the dependency optimizer reaches a napi-rs package, such as `@napi-rs/canvas`. These packages load their native addon through a platform package, such as `@napi-rs/canvas-linux-x64-gnu`, whose entry is the `.node` file itself. The plugin that keeps `.node` files out of the optimizer only matched relative `.node` imports, so the optimizer tried to bundle the binary and failed with "stream did not contain valid UTF-8". Platform packages that resolve to a `.node` file are now kept external too, on both Vite 8 and Vite 7.
