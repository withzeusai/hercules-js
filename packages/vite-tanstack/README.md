# @usehercules/vite-tanstack

Shared Vite and Vitest configuration for Hercules [TanStack Start](https://tanstack.com/start) applications. One `defineConfig()` call gives every app the same plugin stack, path aliases, and dev-server shape, so the platform can rely on them and apps do not carry the boilerplate.

## Installation

```bash
pnpm add -D @usehercules/vite-tanstack
```

Peer dependencies, installed by the app so it controls their versions: `vite`, `@vitejs/plugin-react`, `@tanstack/react-start`, `@tailwindcss/vite`, and optionally `@tanstack/devtools-vite`, `@cloudflare/vite-plugin`, and `vitest`.

`@usehercules/vite` is a regular dependency and does not need to be listed by the app.

## Usage

```ts
// vite.config.ts
import { defineConfig } from "@usehercules/vite-tanstack";

export default defineConfig();
```

```ts
// vitest.config.ts
import { defineVitestConfig } from "@usehercules/vite-tanstack/vitest";

export default defineVitestConfig();
```

## What `defineConfig()` sets up

Plugins, in order:

1. `hercules:hold-pages-during-reload` (dev server only): after a change that reloads the Worker, page requests wait until file changes go quiet, the first one warms the Worker alone, and the rest follow. Without it the first render after a reload can fail with "Invalid hook call". A request is never held longer than 3 seconds.
2. `hercules:prebundle-dependencies` (dev server only): pre-bundles the app's dependencies up front, see below. It runs after the other plugins so it can honor their `optimizeDeps.exclude`.
3. `@tanstack/devtools-vite`, with console piping and enhanced logs off: server logs already reach the terminal, and piping them into the browser prints each line twice.
4. `@tailwindcss/vite`
5. `@usehercules/vite` (component tagger and visual editor endpoints; dev server only). Its own dependency pre-bundling is off, since plugin 2 covers both environments.
6. `@cloudflare/vite-plugin`, targeting the `ssr` environment so the server runs in workerd during dev and builds to a Worker
7. `@tanstack/react-start`
8. `@vitejs/plugin-react`
9. Any plugins you pass

Base config:

- `@` maps to `src/` and `@/convex` maps to `convex/`, matching the `paths` block in the app's `tsconfig.json`. On Vite 8, `resolve.tsconfigPaths` is on as well, so any other `paths` the app adds resolve too.
- React, React DOM, TanStack Query and TanStack Router are deduped so only one copy ever loads.
- Every runtime dependency in the app's `package.json` is pre-bundled in both the browser and the `ssr` environment when the dev server starts, so Vite does not discover a package mid-session. A mid-session discovery re-bundles the dependencies: in the browser, modules still requested with the old version hash fail with 504 "Outdated Optimize Dep" (a lazily loaded route shows "Failed to fetch dynamically imported module") and the page reloads; in the Worker it can load a second React copy and break SSR until a restart. Packages that cannot be bundled are skipped: CSS-only and types-only packages, packages that load a native addon, React (already included), and anything another plugin excludes, such as TanStack Start and Router.
- Subpath entries of the template packages (`PREBUNDLED_ENTRIES`, such as `convex/react`, `motion/react` and `@shadcn/react/message-scroller`) are added when the app declares the package, and the `ssr` environment also scans every file under `src` for imports rather than only the server entries.
- Base UI publishes one entry per component (`@base-ui/react/dialog`, ...), and the optimizer treats each as its own package. When the app declares `@base-ui/react`, every component entry in its export map is pre-bundled too (`PREBUNDLED_EXPORT_MAPS`; `./internals/*` and `./package.json` are skipped), so the first component the agent imports does not trigger a re-bundle and a full reload.
- When `package.json` or the lockfile changes, the dev server restarts once the new packages are installed, so a package the agent just added is pre-bundled before any code imports it. The preview reloads once at that point instead of when the new code first runs.
- Dev server: host `0.0.0.0`, port `5173`, all hosts allowed, HMR overlay off. This is the shape the Hercules preview expects.

On the Hercules dev machine (`HERCULES_DEV_MACHINE=1`, which the machine image sets and herculesd passes on to the dev server) the config also:

- pins the port with `strictPort`, so the preview never points at a fallback port;
- ignores file changes under `.agents`, `.claude`, `.hercules`, `.tanstack/tmp`, `.workspace` and `.wrangler`;
- waits for files to stop changing for one second before triggering HMR, so half-written modules never reach the browser.

`HERCULES_DEV_SERVER=true` turns the same settings on anywhere else.

## Customising

`defineConfig()` accepts either the same values as Vite's own `defineConfig` (an object, a promise, or a function of the config env), which are merged over the defaults, or an options object:

```ts
import { defineConfig } from "@usehercules/vite-tanstack";
import myPlugin from "vite-plugin-mine";

export default defineConfig({
  plugins: [myPlugin()],
  vite: { server: { port: 3000 } },
  react: { babel: { plugins: [] } },
  tanstackStart: { prerender: { enabled: true } },
  cloudflare: { configPath: "./wrangler.prod.jsonc" },
  hercules: { componentTagger: { enabled: false } },
  devtools: false,
  convexDir: false,
});
```

| Option                  | Default    | Description                                                                                                                          |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `plugins`               | `[]`       | Extra Vite plugins, appended after the Hercules stack.                                                                               |
| `prebundle`             | `[]`       | Extra entries to pre-bundle in both environments, such as a subpath (`lodash/debounce`).                                             |
| `prebundleDependencies` | `true`     | `false` pre-bundles only `PREBUNDLED_ENTRIES`, `PREBUNDLED_EXPORT_MAPS` and `prebundle`, and stops restarting on dependency changes. |
| `holdPagesDuringReload` | `true`     | `false` lets page requests through while the dev server reloads the Worker.                                                          |
| `vite`                  |            | Vite options merged over the generated config. Anything set here wins.                                                               |
| `srcDir`                | `"src"`    | Application source directory, mapped to `@`.                                                                                         |
| `convexDir`             | `"convex"` | Convex functions directory, mapped to `@/convex`. `false` for apps without Convex.                                                   |
| `react`                 |            | Options for `@vitejs/plugin-react`.                                                                                                  |
| `tanstackStart`         |            | Options for `tanstackStart()`.                                                                                                       |
| `cloudflare`            |            | Options for `@cloudflare/vite-plugin`. `false` builds without it.                                                                    |
| `hercules`              |            | Options for `@usehercules/vite`. `false` leaves the Hercules dev tooling out.                                                        |
| `devtools`              |            | Options for `@tanstack/devtools-vite`. `false` skips it.                                                                             |
| `tailwind`              | `true`     | Whether to include `@tailwindcss/vite`.                                                                                              |

Optional peers that are not installed are skipped with a warning, unless you configured them explicitly, in which case the missing package is an error.

## What `defineVitestConfig()` sets up

The same aliases and `tsconfigPaths` as the Vite config, `passWithNoTests`, `restoreMocks`, and two projects:

- `convex`: `convex/**/*.test.{ts,js}` in the `edge-runtime` environment, for backend functions run through `convex-test`. Needs `@edge-runtime/vm` in the app.
- `frontend`: `src/**/*.test.{ts,tsx}` in `jsdom` with `@vitejs/plugin-react`, for components and logic through Testing Library. Needs `jsdom` in the app. `src/vitest.setup.ts` is used as a setup file when it exists.

Each project takes `include`, `environment` and `setupFiles`, or `false` to drop it. `vitest` merges arbitrary Vitest options over the result.

## Compatibility

- **Vite**: 7.x / 8.x
- **Vitest**: 3.x / 4.x
- **Node.js**: 20.19+ / 22.12+

## License

MIT
