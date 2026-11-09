---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Keep native addon files out of dependency pre-bundling. `ssh2-sftp-client` is plain JavaScript, but its `ssh2` dependency loads `cpu-features`, which requires `../build/Release/cpufeatures.node`, an addon pnpm does not build by default. Pre-bundling failed with "Could not resolve '../build/Release/cpufeatures.node'", so the dev server exited on every start. The optimizer now leaves such files to be loaded when the code runs, so the package is still pre-bundled in the browser and the Worker.
