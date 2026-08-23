import { readFileSync } from "fs";
import path from "path";
import type { Plugin, Rollup, UserConfig } from "vite";

// Types
export interface ConvexChunkingOptions {
  enabled?: boolean;
  debug?: boolean;
}

const CONVEX_CHUNK_NAME = "convex";

// The callback form of `output.manualChunks`. Vite 8 re-exports Rolldown's
// types through its `Rollup` namespace, which does not publish the callback
// type under a stable name, so derive it from the field itself.
type ManualChunksCallback = NonNullable<Rollup.OutputOptions["manualChunks"]>;

// The object (groups) form of `output.codeSplitting` and one of its groups.
// Rolldown ignores `manualChunks` when `codeSplitting` is set to an object, so
// the convex isolation is expressed as a group in that form instead.
type CodeSplittingObject = Extract<
  NonNullable<Rollup.OutputOptions["codeSplitting"]>,
  { groups?: unknown }
>;
type CodeSplittingGroup = NonNullable<CodeSplittingObject["groups"]>[number];

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
 * The grouping only affects builds that actually code-split. Rolldown disables
 * code splitting — and rejects a `manualChunks` callback — whenever dynamic
 * imports are inlined: SSR builds, library builds (`build.lib`), any output
 * with `inlineDynamicImports`, an explicit `output.codeSplitting: false`, and
 * the `iife`/`umd` output formats (which imply a single bundle). All of those
 * are skipped, along with the multi-output (array) form. When the app drives
 * splitting through the object form of `output.codeSplitting`, Rolldown ignores
 * `manualChunks`, so the isolation is prepended as a high-priority group there
 * instead. For an app that does not depend on convex, or a build that does not
 * code-split, the plugin is a pure no-op: it touches neither the split config
 * nor `optimizeDeps`. `optimizeDeps.include` otherwise keeps the dev
 * pre-bundler treating convex as one unit.
 */
export function convexChunkingPlugin(options: ConvexChunkingOptions = {}): Plugin {
  const { debug = false } = options;

  return {
    name: "vite-plugin-hercules-convex-chunking",
    config(userConfig, env) {
      const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      if (!appDependsOnConvex(root)) {
        return {};
      }

      const output = userConfig.build?.rollupOptions?.output;

      // Only touch config where the output actually code-splits. Rolldown
      // disables splitting — and rejects a `manualChunks` callback — for SSR
      // builds, library builds (`build.lib`), an explicit `inlineDynamicImports`
      // or `codeSplitting: false`, and the single-bundle `iife`/`umd` formats.
      // Installing chunking config in any of those fails the build before
      // bundling. The multi-output (array) form is skipped too: merging a single
      // output object into it would append a stray output rather than compose.
      const format = Array.isArray(output) ? undefined : output?.format;
      const codeSplits =
        !env.isSsrBuild &&
        !userConfig.build?.lib &&
        !Array.isArray(output) &&
        output?.inlineDynamicImports !== true &&
        output?.codeSplitting !== false &&
        format !== "iife" &&
        format !== "umd";

      if (!codeSplits) {
        return {};
      }

      const patch: UserConfig = {
        optimizeDeps: { include: ["convex", "convex/react"] },
      };

      const codeSplitting = output?.codeSplitting;

      if (typeof codeSplitting === "object" && codeSplitting !== null) {
        // Object form: Rolldown ignores `manualChunks` here, so express the
        // isolation as a group. A near-maximal priority captures the convex
        // modules ahead of the app's own groups (higher priority wins and pulls
        // those modules out of the others), so convex still lands in one chunk.
        const convexGroup: CodeSplittingGroup = {
          name: CONVEX_CHUNK_NAME,
          test: (id) => isConvexModule(id),
          priority: Number.MAX_SAFE_INTEGER,
        };
        patch.build = {
          rollupOptions: {
            output: {
              codeSplitting: {
                ...codeSplitting,
                groups: [convexGroup, ...(codeSplitting.groups ?? [])],
              },
            },
          },
        };
        return patch;
      }

      const existing = output?.manualChunks;

      // Compose over an existing function, but never clobber an app that
      // configured the object form of `manualChunks` itself.
      if (existing === undefined || typeof existing === "function") {
        const manualChunks: ManualChunksCallback = (id, meta) => {
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

      return patch;
    },
  };
}
