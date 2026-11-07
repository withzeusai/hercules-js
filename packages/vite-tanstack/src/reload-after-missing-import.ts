import { normalizePath, type Plugin } from "vite";

// An unresolved bare or aliased import fails with ERR_MODULE_NOT_FOUND. An
// unresolved relative one (`./-lib/x.ts`) fails with ERR_LOAD_URL: the
// transform keeps the specifier, and Vite fetches it without its importer.
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_LOAD_URL")
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
 * Worker program reloads when the next file is created. An importer that
 * changes in the meantime is forgotten: the edit may have fixed the import.
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
          if (importer && isMissingFile(error)) importers.add(importer);
          throw error;
        }
      };

      // An edit to the importer re-runs it, so it reports again if still broken.
      const forget = (file: string) => importers.delete(normalizePath(file));
      server.watcher.on("change", forget);
      server.watcher.on("unlink", forget);
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
