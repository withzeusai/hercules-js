import { readFileSync } from "fs";
import path from "path";
import type { Plugin, Rollup, UserConfig } from "vite";

// Types
export interface ConvexChunkingOptions {
  enabled?: boolean;
  debug?: boolean;
}

const CONVEX_CHUNK_NAME = "convex";

// Matches the convex client package in both npm/yarn (`node_modules/convex/…`)
// and pnpm (`node_modules/.pnpm/convex@x/node_modules/convex/…`) layouts. The
// trailing separator keeps sibling packages such as `convex-helpers` and
// `convex-test` out of the group.
const CONVEX_MODULE = /[\\/]node_modules[\\/]convex[\\/]/;

// Matches the app's generated Convex API surface (`convex/_generated/*`), which
// every route imports. These are pure leaf modules, so folding them into the
// convex group is safe and closes the last cross-chunk edge through convex.
const CONVEX_GENERATED = /[\\/]convex[\\/]_generated[\\/]/;

function isConvexModule(id: string): boolean {
  return CONVEX_MODULE.test(id) || CONVEX_GENERATED.test(id);
}

function appDependsOnConvex(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.convex ?? pkg.devDependencies?.convex);
  } catch {
    return false;
  }
}

/**
 * Isolates the Convex client into its own output chunk.
 *
 * Convex holds module-scoped bindings (the react hooks, the value codecs, the
 * `anyApi` proxy behind `_generated/api`) that many lazily-loaded route chunks
 * import. Left to Rollup's default splitting, those bindings can be hoisted
 * into a shared chunk that participates in a circular reference with a route
 * chunk. In the minified production bundle that reference is read before the
 * binding initializes, so the published app throws
 * `Cannot access 'X' before initialization` and renders its error boundary
 * (the crash never reproduces in the dev server, which serves native ESM
 * without chunking). Forcing convex into a single chunk means it is
 * initialized once, before any route chunk that depends on it runs.
 *
 * The manual-chunk grouping only affects the client production build. SSR
 * builds inline dynamic imports, where `manualChunks` is invalid, so they are
 * skipped. `optimizeDeps.include` keeps the dev pre-bundler treating convex as
 * one unit too, and is only added when the app actually depends on convex so
 * apps without it are completely unaffected.
 */
export function convexChunkingPlugin(options: ConvexChunkingOptions = {}): Plugin {
  const { debug = false } = options;

  return {
    name: "vite-plugin-hercules-convex-chunking",
    config(userConfig, env) {
      const patch: UserConfig = {};

      const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      if (appDependsOnConvex(root)) {
        patch.optimizeDeps = { include: ["convex", "convex/react"] };
      }

      const output = userConfig.build?.rollupOptions?.output;

      // Leave the multi-output (array) form untouched: merging a single output
      // object into it would append a stray output rather than compose.
      if (!env.isSsrBuild && !Array.isArray(output)) {
        const existing = output?.manualChunks;

        // Compose over an existing function, but never clobber an app that
        // configured the object form of `manualChunks` itself.
        if (existing === undefined || typeof existing === "function") {
          const manualChunks: Rollup.GetManualChunk = (id, meta) => {
            if (isConvexModule(id)) {
              return CONVEX_CHUNK_NAME;
            }
            return typeof existing === "function" ? existing(id, meta) : undefined;
          };
          patch.build = { rollupOptions: { output: { manualChunks } } };
        } else if (debug) {
          console.log(
            "[Hercules Plugin] Skipped convex chunk isolation: app sets manualChunks as an object.",
          );
        }
      }

      return patch;
    },
  };
}
