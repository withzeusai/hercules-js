import type { Plugin } from "vite";

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND"
  );
}

/**
 * Retries a server import that failed because its file did not exist yet,
 * once a file is created.
 *
 * Agents often write an import before the file it points to. The Worker
 * keeps the failed import (the importer's transform still holds the
 * unresolved specifier, and the module runner caches the rejection), and Vite
 * has no link from the importer to a file that did not exist, so creating the
 * file changes nothing: every page answers 500 until the importer itself
 * changes. So the importers of a missing module are re-transformed and the
 * Worker program reloads when the next file is created.
 */
export function reloadAfterMissingImport(): Plugin {
  return {
    name: "hercules:reload-after-missing-import",
    apply: "serve",
    configureServer(server) {
      const ssr = server.environments.ssr;
      if (!ssr) return;

      const importers = new Set<string>();
      const fetchModule = ssr.fetchModule.bind(ssr);
      ssr.fetchModule = async (id, importer, options) => {
        try {
          return await fetchModule(id, importer, options);
        } catch (error) {
          if (importer && isModuleNotFound(error)) importers.add(importer);
          throw error;
        }
      };

      server.watcher.on("add", () => {
        if (importers.size === 0) return;
        for (const file of importers) {
          for (const mod of ssr.moduleGraph.getModulesByFile(file) ?? []) {
            ssr.moduleGraph.invalidateModule(mod);
          }
        }
        importers.clear();
        ssr.hot.send({ type: "full-reload" });
      });
    },
  };
}
