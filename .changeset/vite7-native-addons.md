---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Fix the dev server exiting on Vite 7 when a dependency loads a native addon, such as `ssh2-sftp-client` through `cpu-features`. The plugin that keeps `.node` files out of the dependency optimizer was only given to Rolldown, which Vite 8 uses. Vite 7 runs the optimizer on esbuild, so it now gets an esbuild version of the same plugin.
