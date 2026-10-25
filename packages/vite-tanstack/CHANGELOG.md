# @usehercules/vite-tanstack

## 0.1.0

### Minor Changes

- [#146](https://github.com/withzeusai/hercules-js/pull/146) [`2565481`](https://github.com/withzeusai/hercules-js/commit/2565481e8fead471e530b3bb28ba8d2489ebe1f6) Thanks [@grant0417](https://github.com/grant0417)! - Add `@usehercules/vite-tanstack`, a shared Vite and Vitest configuration for Hercules TanStack Start applications.

  `defineConfig()` assembles the standard plugin stack (TanStack devtools, Tailwind, `@usehercules/vite`, the Cloudflare Vite plugin targeting the `ssr` environment, TanStack Start, and plugin-react), the `@` and `@/convex` aliases, React and TanStack dedupe, up-front pre-bundling of the template packages in the browser and the Worker, a dev-only plugin that holds page requests while the Worker reloads, and the dev-server shape the Hercules preview expects. When `HERCULES_DEV_SERVER=true` it also pins the port, ignores changes under agent-managed directories, and waits for files to settle before triggering HMR. Plain Vite config values or a per-plugin options object can be passed to customise it.

  `defineVitestConfig()` from `@usehercules/vite-tanstack/vitest` shares the same aliases and defines the `convex` (edge runtime) and `frontend` (jsdom) test projects.

- [#185](https://github.com/withzeusai/hercules-js/pull/185) [`6ad2a56`](https://github.com/withzeusai/hercules-js/commit/6ad2a5625c5adde0b97874ce51dd9460f93dae28) Thanks [@grant0417](https://github.com/grant0417)! - Pre-bundle the app's own dependencies instead of a fixed list. `defineConfig()` now reads the runtime `dependencies` in `package.json` and bundles them up front in the browser and the `ssr` environment, skipping CSS-only and types-only packages, native addons, React, and anything another plugin excludes. The `ssr` environment also scans every file under `src` for imports. When `package.json` or the lockfile changes, the dev server restarts once the new packages are installed, so a package added mid-session is bundled before code imports it and Vite no longer re-optimizes while the app runs (which showed up as 504 "Outdated Optimize Dep", "Failed to fetch dynamically imported module", and unexplained reloads). `PREBUNDLED_PACKAGES` is replaced by `PREBUNDLED_ENTRIES`, which keeps only the subpath entries a package name does not cover. Set `prebundleDependencies: false` to opt out.

  `holdPagesDuringReload` now holds page requests only after the Worker receives a reload. It used to hold any page request within 500 ms of a file event, and miniflare writes its trace store under `.wrangler` on every request, so back-to-back page loads (such as a sign-in redirect) took about 500 ms each.

### Patch Changes

- [#195](https://github.com/withzeusai/hercules-js/pull/195) [`d42e0ab`](https://github.com/withzeusai/hercules-js/commit/d42e0ab6d4fb6521dd46d71829bba5d2aa4caeb0) Thanks [@grant0417](https://github.com/grant0417)! - Require `@tanstack/react-start` 1.169.3 or later. Earlier versions, and the `@tanstack/start-server-core` they pull in, are affected by GHSA-qx66-fv34-fjm8.

- [#193](https://github.com/withzeusai/hercules-js/pull/193) [`f76f96e`](https://github.com/withzeusai/hercules-js/commit/f76f96ec6e9d68f4f9043b4cb56ed68f50a08977) Thanks [@grant0417](https://github.com/grant0417)! - Turn the dev machine settings (`strictPort`, the watch ignores for agent-managed directories, and `awaitWriteFinish`) on when `HERCULES_DEV_MACHINE=1`, which the Hercules dev machine image sets and herculesd passes on to the dev server. They were gated on `HERCULES_DEV_SERVER=true` alone, which nothing on the platform sets, so they never turned on. `HERCULES_DEV_SERVER=true` still works as an alternate trigger.

  Pre-bundle every Base UI component entry when the app declares `@base-ui/react`: each one (`@base-ui/react/dialog`, ...) is its own optimizer entry, read from the package's export map minus `./internals/*`, so the first component the app imports no longer triggers a re-bundle and a full reload. `@shadcn/react/message-scroller` joins `PREBUNDLED_ENTRIES`.

  Turn on `resolve.tsconfigPaths` in the Vite and Vitest configs, next to the `@` and `@/convex` aliases, so any other `paths` the app adds to `tsconfig.json` resolve as well (Vite 8).

  Dependency pre-bundling in both `@usehercules/vite` and `@usehercules/vite-tanstack` now skips CSS-only fontsource packages (`@fontsource-variable/geist` and the like). Their export map lists an `index.d.css.ts` declaration, which was taken for a JavaScript entry, so Vite was asked to bundle a stylesheet.

- [#192](https://github.com/withzeusai/hercules-js/pull/192) [`5128d5d`](https://github.com/withzeusai/hercules-js/commit/5128d5d93275d5589404a738ef8e61ea86273ac6) Thanks [@grant0417](https://github.com/grant0417)! - Turn off `@usehercules/vite`'s new dependency pre-bundling inside the stack, since `hercules:prebundle-dependencies` already covers the browser and the Worker, and drop `prebundleDependencies` from the `hercules` option's type. The package no longer publishes its `src` directory.
- Updated dependencies [[`0c1da2b`](https://github.com/withzeusai/hercules-js/commit/0c1da2ba38fdf594cff1cb34d9dc535ec2c1ade2), [`c277313`](https://github.com/withzeusai/hercules-js/commit/c2773132579db4287f266ebde345a8f7b11c02a5), [`5128d5d`](https://github.com/withzeusai/hercules-js/commit/5128d5d93275d5589404a738ef8e61ea86273ac6), [`f76f96e`](https://github.com/withzeusai/hercules-js/commit/f76f96ec6e9d68f4f9043b4cb56ed68f50a08977)]:
  - @usehercules/vite@2.0.0
