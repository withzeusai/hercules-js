import {
  dependenciesToPrebundle as appDependenciesToPrebundle,
  exportedSubpaths,
  onlyDeclared,
  readDeclaredDependencies,
  sourceEntries,
  watchDependencies,
  withoutExcluded,
  type ExportedSubpathsOptions,
} from "@usehercules/vite-common";
import type { Plugin } from "vite";

/**
 * Entries that a package name alone does not cover, bundled up front on top
 * of the app's dependencies: template packages the app imports by subpath, and
 * a dependency of TanStack Router, which loads from source. Each is kept only
 * when the app declares its package.
 */
export const PREBUNDLED_ENTRIES: readonly string[] = [
  "@tanstack/react-router > @tanstack/react-store",
  "@usehercules/auth-tanstack/client",
  "@usehercules/auth-tanstack/convex",
  "convex/react",
  "convex/server",
  "convex/values",
  "@hookform/resolvers/zod",
  "motion/react",
  "@shadcn/react/message-scroller",
];

/**
 * Template packages that publish one entry per component, such as
 * `@base-ui/react/dialog`. Every subpath in their export map is bundled up
 * front, minus the ones `exclude` drops, so the first component the app
 * imports does not make Vite bundle the dependencies again and reload the
 * page. Each is expanded only when the app declares it.
 */
export const PREBUNDLED_EXPORT_MAPS: Readonly<Record<string, ExportedSubpathsOptions>> = {
  // `internals/` holds hooks the components import from inside the package.
  "@base-ui/react": { exclude: (subpath) => subpath.startsWith("./internals/") },
};

/** Server-only entries, on top of {@link PREBUNDLED_ENTRIES}. */
export const SSR_PREBUNDLED_ENTRIES: readonly string[] = ["convex/browser"];

/**
 * Dependencies never bundled up front. Vite and TanStack Start already include
 * React. Start loads its own and the router's packages from source, so the app
 * and Start's virtual modules share one router; Start also lists them in
 * `optimizeDeps.exclude`, which the plugin honours for anything else.
 */
const NEVER_PREBUNDLED: ReadonlySet<string> = new Set([
  "react",
  "react-dom",
  "@tanstack/react-start",
  "@tanstack/react-router",
  "@tanstack/react-router-devtools",
]);

/**
 * The app's runtime `dependencies` that can be bundled up front, read from
 * the installed packages. A dependency that is declared but not installed yet
 * is left out until it is, so a restart in the middle of an install does not
 * drop it with a "Failed to resolve dependency" warning.
 */
export function dependenciesToPrebundle(root: string): string[] {
  return appDependenciesToPrebundle(root, NEVER_PREBUNDLED);
}

export interface PrebundleOptions {
  /** Vite root, where the app's `package.json` and `node_modules` live. */
  root: string;
  /** Application source directory, relative to the root. */
  srcDir: string;
  /** Read `dependencies` from `package.json` and bundle them up front. */
  dependencies: boolean;
  /** Extra entries for both environments. */
  extra: readonly string[];
}

function entriesFor(
  environment: "client" | "ssr",
  options: PrebundleOptions,
  dependencies: readonly string[],
): string[] {
  const declared = readDeclaredDependencies(options.root);
  return [
    ...dependencies,
    ...onlyDeclared(PREBUNDLED_ENTRIES, declared),
    ...exportMapEntries(options.root, declared),
    ...(environment === "ssr" ? onlyDeclared(SSR_PREBUNDLED_ENTRIES, declared) : []),
    ...options.extra,
  ];
}

/** The subpath entries of each {@link PREBUNDLED_EXPORT_MAPS} package the app declares. */
function exportMapEntries(root: string, declared: Set<string> | undefined): string[] {
  return onlyDeclared(Object.keys(PREBUNDLED_EXPORT_MAPS), declared).flatMap((name) =>
    exportedSubpaths(root, name, PREBUNDLED_EXPORT_MAPS[name]),
  );
}

/**
 * Bundles the app's dependencies up front in the browser and the Worker
 * (`ssr`) environment, so Vite does not discover a package mid-session.
 *
 * A package Vite discovers while the app runs makes it bundle the
 * dependencies again. In the browser that changes their version hash: modules
 * still being fetched with the old hash fail with 504 "Outdated Optimize Dep"
 * ("Failed to fetch dynamically imported module" for a lazily loaded route),
 * then the page reloads. In the Worker it can load a second React copy and
 * break server rendering until a restart.
 *
 * So every runtime dependency the app declares is bundled when the server
 * starts, minus packages that cannot be (CSS or types only, native addons, or
 * excluded by another plugin), and the Worker scans the whole source tree
 * rather than only the server entries. When `package.json` or the lockfile
 * changes, the dev server restarts so a package the agent just installed is
 * bundled before any code imports it.
 */
export function prebundleDependencies(options: PrebundleOptions): Plugin {
  // Read once per server start, so both environments and the watcher agree.
  let dependencies: string[] | undefined;
  const configuredDependencies = () =>
    (dependencies ??= options.dependencies ? dependenciesToPrebundle(options.root) : []);

  return {
    name: "hercules:prebundle-dependencies",
    apply: "serve",
    // After TanStack Start and the Cloudflare plugin, so their excludes are known.
    enforce: "post",
    configEnvironment(name, config) {
      if (name !== "client" && name !== "ssr") return;
      const entries = entriesFor(name, options, configuredDependencies());
      return {
        optimizeDeps: {
          include: withoutExcluded(entries, config.optimizeDeps?.exclude),
          ...(name === "ssr" ? { entries: sourceEntries(options.srcDir) } : {}),
        },
      };
    },
    configureServer(server) {
      if (!options.dependencies) return;
      watchDependencies(server, {
        root: options.root,
        started: configuredDependencies(),
        current: () => dependenciesToPrebundle(options.root),
      });
    },
  };
}
