import type { Plugin } from "vite";

/**
 * Compiles a route file before its split chunk (`?tsr-split=component`) or
 * its shared module (`?tsr-shared=1`) when one of those is requested first.
 *
 * Workaround for https://github.com/TanStack/router/issues/8754. Remove it
 * once `@tanstack/router-plugin` ships the fix. The code splitter learns which
 * bindings the kept and the split options share, such as a query used by both
 * `loader` and `component`, only when it compiles the route file. A shared
 * module compiled before that is the whole route file without those exports,
 * and the browser fails with "Importing binding name 'x' is not found" until
 * the file changes. A split chunk compiled before that declares its own copy.
 */
export function compileRouteFileFirst(): Plugin {
  return {
    name: "hercules:compile-route-file-first",
    apply: "serve",
    transform: {
      // Ahead of the code splitter's transforms.
      order: "pre",
      // Only the chunks a page imports. Other queries, such as TanStack
      // Start's server function lookups, can be awaited by the route file's
      // own compile, so waiting for the route file there could deadlock.
      filter: { id: /\?tsr-(?:split=[^&]+|shared=1)$/ },
      async handler(_code, id) {
        // Never true with `apply: "serve"`. It narrows the type to DevEnvironment.
        if (this.environment.mode !== "dev") return;
        const url = this.environment.moduleGraph.getModuleById(id)?.url.split("?")[0];
        if (!url) return;
        // Returns the cached result once the route file is compiled, and
        // joins the request already compiling it. If it fails, the chunk is
        // compiled as before.
        await this.environment.transformRequest(url).catch(() => {});
      },
    },
  };
}
