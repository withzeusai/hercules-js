import type { EnvironmentModuleNode, Plugin } from "vite";

// The route tree TanStack Router generates from the routes directory, under
// its default name. It imports every route file and is rewritten without the
// deleted one.
export const GENERATED_ROUTE_TREE = /(^|\/)routeTree\.gen\.[cm]?[jt]s$/;

/**
 * Whether nothing outside the deleted file loads it, other than the route
 * tree: the file's own modules (a route imports its split chunks,
 * `?tsr-split=component`) do not count.
 */
function onlyUsedByRouteTree(modules: EnvironmentModuleNode[], file: string): boolean {
  return modules.every((mod) =>
    [...mod.importers].every(
      (importer) =>
        importer.file === file ||
        (importer.file !== null && GENERATED_ROUTE_TREE.test(importer.file)),
    ),
  );
}

/**
 * Skips the hot update for a deleted file that only the route tree imports,
 * such as a route file the agent removed or moved under a layout.
 *
 * Vite handles a deleted file like an edited one. A route module accepts its
 * own updates, so the browser is told to import the file again, which can only
 * fail: the request answers 404 or 500, and the browser logs "[vite] Failed to
 * reload" and "[vite] Internal Server Error ENOENT", which the Hercules preview
 * reports as a bug. The Worker reloads its program too, and that run imports
 * the route tree from before the delete and logs "Failed to load url
 * /src/routes/... in routeTree.gen.ts". Both are moot: TanStack Router
 * rewrites the route tree within a second, and that change reloads the page
 * and the Worker. So the deleted file's modules are only invalidated, and
 * the update goes ahead without them.
 *
 * A deleted file that other modules still import is left to Vite: they are
 * broken now, and the failed update is the first sign of it.
 */
export function skipDeletedRouteUpdates(): Plugin {
  return {
    name: "hercules:skip-deleted-route-updates",
    apply: "serve",
    hotUpdate: {
      // After the other plugins, so it filters the modules they return.
      order: "post",
      handler({ type, file, modules }) {
        if (type !== "delete") return;
        // The file's modules. A stylesheet that scans it for class names
        // (Tailwind) also holds a file-only entry for it, without an id; that
        // one still updates, so the stylesheet drops the file's classes.
        const deleted = modules.filter((mod) => mod.file === file && mod.id !== null);
        if (deleted.length === 0 || !onlyUsedByRouteTree(deleted, file)) return;
        const seen = new Set<EnvironmentModuleNode>();
        for (const mod of deleted) this.environment.moduleGraph.invalidateModule(mod, seen);
        return modules.filter((mod) => !deleted.includes(mod));
      },
    },
  };
}
