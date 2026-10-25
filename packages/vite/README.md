# @usehercules/vite

The Vite plugin for Hercules apps. It runs on the dev server only and supports **Vite 7 and Vite 8**.

## Installation

```bash
pnpm add -D @usehercules/vite
```

## Usage

```typescript
import { defineConfig } from "vite";
import hercules from "@usehercules/vite";

export default defineConfig({
  plugins: [hercules()],
});
```

TanStack Start apps get the plugin through `@usehercules/vite-tanstack` instead.

## What it does

- **Component tagging.** Adds `data-hercules-id="<file>:<line>:<column>"` and `data-hercules-name` to every JSX element, so the visual editor can map a DOM node back to its source. Line and column come from the file on disk, even when an earlier plugin changed the code. On Vite 8 the tagger parses with Vite's own parser (Oxc); on Vite 7 it uses Babel.
- **Visual editor endpoints.** `/__hercules_analyze_element`, `/__hercules_update_element` and `/__hercules_delete_element`, which the visual editor calls to read and change the source behind a tagged element.
- **Dependency pre-bundling.** Seeds the optimizer from every file under `src` (minus tests, `*.server.*` and `src/server/`), and bundles every runtime dependency in `package.json` up front, so Vite does not discover a package mid-session and reload the page. On the Hercules dev machine (`HERCULES_DEV_MACHINE=1`) the dev server also restarts when `package.json` or the lockfile changes, so a package the agent installs is bundled before code imports it.

herculesd serves the visual editor and error handler scripts and injects them into every page; this plugin does not.

## Options

| Option                    | Type      | Default | Description                                                                                            |
| ------------------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `componentTagger.enabled` | `boolean` | `true`  | Tag JSX elements with data attributes.                                                                 |
| `componentTagger.debug`   | `boolean` | `false` | Log how many elements each file got.                                                                   |
| `visualEditor.enabled`    | `boolean` | `true`  | Serve the visual editor endpoints. When off, elements are tagged with `data-component-id` instead.     |
| `visualEditor.debug`      | `boolean` | `false` | Log endpoint errors.                                                                                   |
| `prebundleDependencies`   | `boolean` | `true`  | Bundle the `package.json` dependencies up front, and restart on dependency changes on the dev machine. |

## Builds stay clean

Every plugin here is `apply: "serve"`, so `vite build` never runs them. Built output contains no tagging attributes and no Hercules endpoints, whatever `NODE_ENV` is.

## Compatibility

- **Vite**: 7.x / 8.x
- **Node.js**: 20.19+ / 22.12+

## Development

```bash
pnpm install
pnpm --filter @usehercules/vite build
pnpm --filter @usehercules/vite test
```

The package bundles the private `@usehercules/vite-common` workspace package into its `dist`; `src/dist.test.ts` fails if a build still imports it.

## License

MIT
