import { readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import type { BuildOptions, EnvironmentOptions, Plugin, Rollup } from "vite";

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

// The deprecated `output.advancedChunks` form. Rolldown still accepts it and,
// when `codeSplitting` is not set, uses it as the splitter — ignoring the
// `manualChunks` callback — so the convex isolation must be expressed as a
// group here too. Its group element is the same `CodeSplittingGroup`.
type AdvancedChunksObject = NonNullable<Rollup.OutputOptions["advancedChunks"]>;

// A single output object (the array/multi-output form is never patched).
type OutputObject = Rollup.OutputOptions;

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

// The app "depends on" convex when convex is reachable from its root — either
// declared directly in the manifest, or resolvable through the dependency tree
// (e.g. provided transitively by `@usehercules/auth` / `@usehercules/convex`).
// The manifest-only check misses the transitive case: the app source still
// imports convex and still hits the TDZ crash, but the plugin would no-op. Fall
// back to Node resolution so the isolation applies whenever convex is present.
function appDependsOnConvex(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.convex ?? pkg.devDependencies?.convex) {
      return true;
    }
  } catch {
    // fall through to resolution
  }

  try {
    createRequire(path.join(root, "package.json")).resolve("convex/package.json");
    return true;
  } catch {
    return false;
  }
}

// The convex isolation group, used for both the `codeSplitting` object form and
// the deprecated `advancedChunks` form.
//
// A near-maximal priority captures the convex modules ahead of the app's own
// groups (higher priority wins and pulls those modules out of the others).
//
// Rolldown applies the top-level size limits as fallbacks to any group that
// does not set them itself, so an app's global constraints would otherwise leak
// into this group and defeat the isolation: a large `minSize`/`minModuleSize`
// drops the group (convex falls back to auto chunking), and a small
// `maxSize`/`maxModuleSize` — with `includeDependenciesRecursively` off —
// leaves convex modules behind in a shared chunk. Pin every size limit and
// force recursive dependency inclusion so the group is always emitted as
// exactly one self-contained leaf chunk regardless of the global settings.
function makeConvexGroup(): CodeSplittingGroup {
  return {
    name: CONVEX_CHUNK_NAME,
    test: (id) => isConvexModule(id),
    priority: Number.MAX_SAFE_INTEGER,
    minSize: 0,
    maxSize: Infinity,
    minShareCount: 1,
    minModuleSize: 0,
    maxModuleSize: Infinity,
    includeDependenciesRecursively: true,
  };
}

function hasConvexGroup(groups: readonly CodeSplittingGroup[] | undefined): boolean {
  return Boolean(groups?.some((group) => group.name === CONVEX_CHUNK_NAME));
}

// Whether this environment's output actually code-splits. Rolldown disables
// splitting — and rejects a `manualChunks` callback — for library builds
// (`build.lib`), an explicit `inlineDynamicImports` or `codeSplitting: false`,
// and the single-bundle `iife`/`umd` formats. The multi-output (array) form is
// skipped too: merging a single output object into it would append a stray
// output rather than compose. SSR is handled separately by the caller.
function outputCodeSplits(build: BuildOptions | undefined): boolean {
  if (build?.lib) {
    return false;
  }
  const output = build?.rollupOptions?.output;
  if (Array.isArray(output)) {
    return false;
  }
  const format = output?.format;
  return (
    output?.inlineDynamicImports !== true &&
    output?.codeSplitting !== false &&
    format !== "iife" &&
    format !== "umd"
  );
}

// Build the output patch that isolates convex for a code-splitting environment.
// Returns `undefined` when there is nothing to compose (the app configured
// `manualChunks` as an object, or a convex group is already present).
//
// The returned patch is deeply merged into the environment config by Vite,
// which concatenates arrays. So the group branches contribute only the convex
// group itself: Vite appends it to the app's own groups rather than us
// re-listing them (which would duplicate them). The high priority — not the
// array position — is what makes the group capture convex first.
function convexOutputPatch(
  output: OutputObject | undefined,
  debug: boolean,
): OutputObject | undefined {
  const codeSplitting = output?.codeSplitting;
  if (typeof codeSplitting === "object" && codeSplitting !== null) {
    // Object form: Rolldown ignores `manualChunks` here, so add the group.
    if (hasConvexGroup(codeSplitting.groups)) {
      return undefined;
    }
    return { codeSplitting: { groups: [makeConvexGroup()] } };
  }

  const advancedChunks = output?.advancedChunks;
  if (typeof advancedChunks === "object" && advancedChunks !== null) {
    // Deprecated form: with no `codeSplitting` set, Rolldown uses this as the
    // splitter and ignores `manualChunks`, so add the group here instead.
    if (hasConvexGroup(advancedChunks.groups as CodeSplittingGroup[] | undefined)) {
      return undefined;
    }
    return { advancedChunks: { groups: [makeConvexGroup()] } as AdvancedChunksObject };
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
    return { manualChunks };
  }

  if (debug) {
    console.log(
      "[Hercules Plugin] Skipped convex chunk isolation: app sets manualChunks as an object.",
    );
  }
  return undefined;
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
 * The isolation is applied per-environment through `configEnvironment`, not
 * once at the top level. Vite 8's multi-environment builder inherits the
 * top-level build config into every environment, so a top-level `manualChunks`
 * would leak into an environment that disables code splitting (e.g. an
 * `environments.ssr` with `output.codeSplitting: false`) and Rolldown would
 * abort. Deciding per environment isolates each one independently: the client
 * environment code-splits and gets convex isolated, while a non-splitting
 * environment is left untouched.
 *
 * The grouping only affects environments that actually code-split. Rolldown
 * disables code splitting — and rejects a `manualChunks` callback — whenever
 * dynamic imports are inlined: SSR builds, library builds (`build.lib`), any
 * output with `inlineDynamicImports`, an explicit `output.codeSplitting: false`,
 * and the `iife`/`umd` output formats (which imply a single bundle). All of
 * those are skipped, along with the multi-output (array) form. When the app
 * drives splitting through the object form of `output.codeSplitting` (or the
 * deprecated `output.advancedChunks`), Rolldown ignores `manualChunks`, so the
 * isolation is added as a high-priority group there instead. For an app
 * that does not depend on convex, or a build that does not code-split, the
 * plugin is a pure no-op: it touches neither the split config nor
 * `optimizeDeps`. `optimizeDeps.include` otherwise keeps the dev pre-bundler
 * treating convex as one unit.
 */
export function convexChunkingPlugin(options: ConvexChunkingOptions = {}): Plugin {
  const { debug = false } = options;

  let dependsOnConvex = false;

  return {
    name: "vite-plugin-hercules-convex-chunking",
    config(userConfig) {
      // Resolve convex detection once against the project root. The per-
      // environment decision happens in `configEnvironment`, which does not
      // receive the root.
      const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      dependsOnConvex = appDependsOnConvex(root);
    },
    configEnvironment(_name, envConfig, env) {
      if (!dependsOnConvex) {
        return;
      }

      // SSR builds disable code splitting and reject a `manualChunks` callback.
      // `env.isSsrBuild` covers the CLI `--ssr` flag and `env.isSsrTargetWebworker`
      // the `ssr.target: "webworker"` case; `envConfig.build.ssr` covers a
      // `build.ssr` set in the config file (per-environment, so it never falsely
      // skips a sibling client environment).
      if (env.isSsrBuild || env.isSsrTargetWebworker || envConfig.build?.ssr) {
        return;
      }

      if (!outputCodeSplits(envConfig.build)) {
        return;
      }

      const output = envConfig.build?.rollupOptions?.output;
      const outputPatch = convexOutputPatch(Array.isArray(output) ? undefined : output, debug);
      if (!outputPatch) {
        return;
      }

      return {
        optimizeDeps: { include: ["convex", "convex/react"] },
        build: { rollupOptions: { output: outputPatch } },
      } satisfies EnvironmentOptions;
    },
  };
}
