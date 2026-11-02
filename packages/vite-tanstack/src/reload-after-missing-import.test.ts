import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { reloadAfterMissingImport } from "./reload-after-missing-import";

const ROOT = "/app/src/routes/__root.tsx";

function notFound(): Error {
  return Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" });
}

function start(fetchModule: (id: string, importer?: string) => Promise<unknown>) {
  const watcher = new EventEmitter();
  const rootModule = { file: ROOT };
  const ssr = {
    fetchModule: vi.fn(fetchModule),
    hot: { send: vi.fn() },
    moduleGraph: {
      getModulesByFile: vi.fn((file: string) =>
        file === ROOT ? new Set([rootModule]) : undefined,
      ),
      invalidateModule: vi.fn(),
    },
  };
  const server = { watcher, environments: { ssr } } as unknown as ViteDevServer;
  const plugin = reloadAfterMissingImport();
  (plugin.configureServer as (server: ViteDevServer) => void)(server);
  const fetch = (id: string, importer?: string) =>
    (server.environments.ssr!.fetchModule as (id: string, importer?: string) => Promise<unknown>)(
      id,
      importer,
    );
  return { watcher, ssr, rootModule, fetch };
}

describe("reloadAfterMissingImport", () => {
  it("re-transforms the importer and reloads the Worker once a file is created", async () => {
    const { watcher, ssr, rootModule, fetch } = start(() => Promise.reject(notFound()));
    await expect(fetch("@/hooks/use-later.ts", ROOT)).rejects.toThrow("Cannot find module");

    watcher.emit("add", "/app/src/hooks/use-later.ts");
    expect(ssr.moduleGraph.invalidateModule).toHaveBeenCalledWith(rootModule);
    expect(ssr.hot.send).toHaveBeenCalledExactlyOnceWith({ type: "full-reload" });

    // Handled: later files do not reload again.
    watcher.emit("add", "/app/src/other.ts");
    expect(ssr.hot.send).toHaveBeenCalledOnce();
  });

  it("leaves the Worker alone when no import failed", async () => {
    const { watcher, ssr, fetch } = start(() => Promise.resolve({ code: "" }));
    await fetch("/src/routes/__root.tsx");
    watcher.emit("add", "/app/src/hooks/new.ts");
    expect(ssr.hot.send).not.toHaveBeenCalled();
  });

  it("ignores other module errors", async () => {
    const { watcher, ssr, fetch } = start(() => Promise.reject(new Error("Transform failed")));
    await expect(fetch("/src/broken.tsx", ROOT)).rejects.toThrow("Transform failed");
    watcher.emit("add", "/app/src/hooks/new.ts");
    expect(ssr.hot.send).not.toHaveBeenCalled();
  });
});
