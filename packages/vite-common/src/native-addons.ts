import path from "node:path";
import * as vite from "vite";
import type { DepOptimizationOptions, Rolldown } from "vite";
import { PLATFORM_PACKAGE } from "./dependencies";

type EsbuildPlugin = NonNullable<
  NonNullable<DepOptimizationOptions["esbuildOptions"]>["plugins"]
>[number];

/** A relative import that names a compiled addon, such as `../build/Release/cpufeatures.node`. */
const ADDON_FILE = /^\.\.?\/.*\.node$/;

/** An import that can load an addon: an `ADDON_FILE` or a `PLATFORM_PACKAGE`. */
const ADDON_IMPORT = new RegExp(`${ADDON_FILE.source}|${PLATFORM_PACKAGE.source}`);

/**
 * Leaves `.node` addon files out of the optimizer bundle. A package can reach
 * one through its own dependencies: `ssh2-sftp-client` loads `ssh2`, which
 * loads `cpu-features`, which requires `../build/Release/cpufeatures.node`.
 * The file is missing when pnpm skips the build script, and the optimizer
 * cannot bundle it when it is there, so the whole run fails and the dev
 * server exits. Kept external, the file is loaded only if that code runs, and
 * `ssh2` loads `cpu-features` inside `try`. A name that resolves to a script,
 * such as `react-dom`'s `./server.node` for `server.node.js`, is bundled as usual.
 *
 * napi-rs packages load the addon by package name instead: `@napi-rs/canvas`
 * requires `@napi-rs/canvas-linux-x64-gnu`, whose `main` is the `.node` file,
 * so a platform build that resolves to one is kept external too. One that is
 * not installed resolves as it would without this plugin.
 */
export function nativeAddonsExternal(): Rolldown.Plugin {
  return {
    name: "hercules:native-addons-external",
    resolveId: {
      filter: { id: ADDON_IMPORT },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved) {
          return resolved.id.endsWith(".node") ? { id: resolved.id, external: true } : resolved;
        }
        if (!ADDON_FILE.test(source)) return null;
        const file = importer ? path.resolve(path.dirname(importer), source) : source;
        return { id: file, external: true };
      },
    },
  };
}

/** Marks the lookup `nativeAddonsExternalEsbuild` makes, so it skips its own hook. */
const RESOLVING_ADDON = Symbol("hercules:native-addons-external");

/** `nativeAddonsExternal` for esbuild, which runs the optimizer on Vite 7. */
export function nativeAddonsExternalEsbuild(): EsbuildPlugin {
  return {
    name: "hercules:native-addons-external",
    setup(build) {
      build.onResolve({ filter: ADDON_IMPORT }, async (args) => {
        if (args.pluginData === RESOLVING_ADDON) return undefined;
        const { path: resolved, errors } = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: RESOLVING_ADDON,
        });
        if (errors.length === 0) {
          return resolved.endsWith(".node") ? { path: resolved, external: true } : undefined;
        }
        if (!ADDON_FILE.test(args.path)) return undefined;
        return { path: path.resolve(args.resolveDir, args.path), external: true };
      });
    },
  };
}

/**
 * Optimizer options that keep native addon files external. Vite 8 bundles
 * dependencies with Rolldown and Vite 7 with esbuild, and each ignores the
 * other's options. Only Vite builds on Rolldown export `rolldownVersion`.
 */
export function nativeAddonsOptimizerOptions(
  usesRolldown = "rolldownVersion" in vite,
): Pick<DepOptimizationOptions, "rolldownOptions" | "esbuildOptions"> {
  return usesRolldown
    ? { rolldownOptions: { plugins: [nativeAddonsExternal()] } }
    : { esbuildOptions: { plugins: [nativeAddonsExternalEsbuild()] } };
}
