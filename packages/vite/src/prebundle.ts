import path from "node:path";
import {
  dependenciesToPrebundle,
  isHerculesDevMachine,
  sourceEntries,
  watchDependencies,
  withoutExcluded,
} from "@usehercules/vite-common";
import type { Plugin } from "vite";

/** Vite bundles React up front by itself. */
const NEVER_PREBUNDLED: ReadonlySet<string> = new Set(["react", "react-dom"]);

/**
 * Seeds the dependency optimizer from every source file, not just the deps
 * reachable from the entry's static import graph. Large apps import most
 * routes through `lazy(() => import(...))`; deps used only inside those lazy
 * chunks are otherwise discovered when the route is first visited, which
 * forces a mid-session re-optimize + full reload. During that reload some
 * modules stay bound to the previous optimizer generation of React while
 * react-dom loads the new one, so react-dom reads another React instance's
 * internals (null) and crashes in useContext/useMemo. Crawling all of src at
 * startup settles the optimizer once so it never re-bundles mid-session. Every
 * project HTML entry is still discovered (Vite's default), so multi-page
 * inputs are not dropped. Server-only code is kept out of the client
 * optimizer: deps under convex/ are never reached, and server modules
 * colocated in src (src/server/**, *.server.*) are excluded so their Node-only
 * imports never become optimizer roots.
 */
export function optimizerEntriesPlugin(): Plugin {
  return {
    name: "vite-plugin-hercules",
    apply: "serve",
    config(userConfig) {
      // Defining `optimizeDeps.entries` overrides Vite's default of deriving
      // entries from `build.rollupOptions.input`, so a custom/library-mode app
      // whose configured input lives outside `src` (e.g. `app/main.ts`) would
      // lose dep discovery. Preserve any explicitly configured input by
      // prepending it to our crawl. `input` may be a string, string[], or a
      // Record of alias -> path; normalize all three to a flat string[].
      const configuredInput = userConfig.build?.rollupOptions?.input;
      const inputEntries =
        typeof configuredInput === "string"
          ? [configuredInput]
          : Array.isArray(configuredInput)
            ? configuredInput
            : configuredInput
              ? Object.values(configuredInput)
              : [];
      return {
        optimizeDeps: {
          entries: [...inputEntries, "**/*.html", ...sourceEntries("src", { serverFiles: false })],
        },
      };
    },
  };
}

/**
 * Bundles the app's runtime dependencies up front in the browser, so Vite
 * does not discover a package mid-session. The source crawl above only finds
 * packages the code already imports; this also covers one the agent just
 * installed and is about to use. Packages that cannot be bundled (CSS or
 * types only, native addons, or excluded by the app or another plugin) are
 * skipped.
 *
 * On the Hercules dev machine the dev server restarts when `package.json` or
 * the lockfile changes and the bundled set differs, so the new package is
 * bundled before any code imports it. A local `vite dev` never restarts by
 * itself.
 */
export function prebundleDependenciesPlugin(): Plugin {
  let root = process.cwd();
  // Read once per server start, so the optimizer and the watcher agree.
  let dependencies: string[] | undefined;
  const configuredDependencies = () =>
    (dependencies ??= dependenciesToPrebundle(root, NEVER_PREBUNDLED));

  return {
    name: "vite-plugin-hercules-prebundle-dependencies",
    apply: "serve",
    // After the other plugins, so their excludes are known.
    enforce: "post",
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
    },
    configEnvironment(name, config) {
      if (name !== "client") return;
      return {
        optimizeDeps: {
          include: withoutExcluded([...configuredDependencies()], config.optimizeDeps?.exclude),
        },
      };
    },
    configureServer(server) {
      if (!isHerculesDevMachine()) return;
      watchDependencies(server, {
        root,
        started: configuredDependencies(),
        current: () => dependenciesToPrebundle(root, NEVER_PREBUNDLED),
      });
    },
  };
}
