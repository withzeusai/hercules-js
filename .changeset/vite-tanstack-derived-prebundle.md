---
"@usehercules/vite-tanstack": minor
---

Pre-bundle the app's own dependencies instead of a fixed list. `defineConfig()` now reads the runtime `dependencies` in `package.json` and bundles them up front in the browser and the `ssr` environment, skipping CSS-only and types-only packages, native addons, React, and anything another plugin excludes. The `ssr` environment also scans every file under `src` for imports. When `package.json` or the lockfile changes, the dev server restarts once the new packages are installed, so a package added mid-session is bundled before code imports it and Vite no longer re-optimizes while the app runs (which showed up as 504 "Outdated Optimize Dep", "Failed to fetch dynamically imported module", and unexplained reloads). `PREBUNDLED_PACKAGES` is replaced by `PREBUNDLED_ENTRIES`, which keeps only the subpath entries a package name does not cover. Set `prebundleDependencies: false` to opt out.
