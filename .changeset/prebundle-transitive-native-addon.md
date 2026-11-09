---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Leave a dependency out of pre-bundling when one of its own dependencies loads a native addon. `ssh2-sftp-client` is plain JavaScript, but its `ssh2` dependency requires `cpu-features`, whose addon pnpm does not build by default. Pre-bundling it failed with "Could not resolve '../build/Release/cpufeatures.node'", so the dev server exited on every start and the Hercules dev machine shut down with it. Only the first level is checked, so packages that reach build tooling further down, such as `@tanstack/react-start`, are still pre-bundled.
