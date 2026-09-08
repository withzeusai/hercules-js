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

1. `@tanstack/devtools-vite`
2. `@tailwindcss/vite`
3. `@usehercules/vite` (component tagger, visual editor, error forwarding; dev server only)
4. `@cloudflare/vite-plugin`, targeting the `ssr` environment so the server runs in workerd during dev and builds to a Worker
5. `@tanstack/react-start`
6. `@vitejs/plugin-react`
7. Any plugins you pass

Base config:

- `@` maps to `src/` and `@/convex` maps to `convex/`, matching the `paths` block in the app's `tsconfig.json`.
- React, React DOM, TanStack Query and TanStack Router are deduped so only one copy ever loads.
- React is pre-bundled by the dependency optimizer.
- Dev server: host `0.0.0.0`, port `5173`, all hosts allowed, HMR overlay off. This is the shape the Hercules preview expects.

When `HERCULES_DEV_SERVER=true` (set on the Hercules dev machine) the config also:

- pins the port with `strictPort`, so the preview never points at a fallback port;
- ignores file changes under `.agents`, `.claude`, `.hercules`, `.tanstack/tmp`, `.workspace` and `.wrangler`;
- waits for files to stop changing for one second before triggering HMR, so half-written modules never reach the browser.

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

| Option          | Default    | Description                                                                        |
| --------------- | ---------- | ---------------------------------------------------------------------------------- |
| `plugins`       | `[]`       | Extra Vite plugins, appended after the Hercules stack.                             |
| `vite`          |            | Vite options merged over the generated config. Anything set here wins.             |
| `srcDir`        | `"src"`    | Application source directory, mapped to `@`.                                       |
| `convexDir`     | `"convex"` | Convex functions directory, mapped to `@/convex`. `false` for apps without Convex. |
| `react`         |            | Options for `@vitejs/plugin-react`.                                                |
| `tanstackStart` |            | Options for `tanstackStart()`.                                                     |
| `cloudflare`    |            | Options for `@cloudflare/vite-plugin`. `false` builds without it.                  |
| `hercules`      |            | Options for `@usehercules/vite`. `false` leaves the Hercules dev tooling out.      |
| `devtools`      |            | Options for `@tanstack/devtools-vite`. `false` skips it.                           |
| `tailwind`      | `true`     | Whether to include `@tailwindcss/vite`.                                            |

Optional peers that are not installed are skipped with a warning, unless you configured them explicitly, in which case the missing package is an error.

## What `defineVitestConfig()` sets up

The same aliases as the Vite config, `passWithNoTests`, `restoreMocks`, and two projects:

- `convex`: `convex/**/*.test.{ts,js}` in the `edge-runtime` environment, for backend functions run through `convex-test`. Needs `@edge-runtime/vm` in the app.
- `frontend`: `src/**/*.test.{ts,tsx}` in `jsdom` with `@vitejs/plugin-react`, for components and logic through Testing Library. Needs `jsdom` in the app. `src/vitest.setup.ts` is used as a setup file when it exists.

Each project takes `include`, `environment` and `setupFiles`, or `false` to drop it. `vitest` merges arbitrary Vitest options over the result.

## Compatibility

- **Vite**: 7.x / 8.x
- **Vitest**: 3.x / 4.x
- **Node.js**: 20.19+ / 22.12+

## License

MIT
