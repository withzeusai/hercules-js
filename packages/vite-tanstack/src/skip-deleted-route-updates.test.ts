import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  normalizePath,
  type EnvironmentModuleNode,
  type HotPayload,
  type HotUpdateOptions,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { skipDeletedRouteUpdates } from "./skip-deleted-route-updates";

const ROUTE = "/app/src/routes/index.tsx";

function node(
  id: string | null,
  importers: EnvironmentModuleNode[] = [],
  file = id?.split("?")[0],
): EnvironmentModuleNode {
  return { id, file, importers: new Set(importers) } as unknown as EnvironmentModuleNode;
}

function run(options: Partial<HotUpdateOptions>) {
  const invalidateModule = vi.fn();
  const plugin = skipDeletedRouteUpdates();
  const { handler } = plugin.hotUpdate as {
    handler: (this: object, options: HotUpdateOptions) => EnvironmentModuleNode[] | undefined;
  };
  const result = handler.call({ environment: { moduleGraph: { invalidateModule } } }, {
    type: "delete",
    file: ROUTE,
    modules: [],
    ...options,
  } as HotUpdateOptions);
  return { result, invalidateModule };
}

describe("skipDeletedRouteUpdates", () => {
  it("drops the update for a deleted route that only the route tree imports", () => {
    const routeTree = node("/app/src/routeTree.gen.ts");
    const route = node(ROUTE, [routeTree]);
    const split = node(`${ROUTE}?tsr-split=component`, [route]);
    // Tailwind scans the route for class names: a file-only entry the stylesheet imports.
    const scanned = node(null, [node("/app/src/index.css?direct")], ROUTE);

    const { result, invalidateModule } = run({ modules: [scanned, route, split] });
    // The stylesheet still updates, to drop the route's classes.
    expect(result).toEqual([scanned]);
    expect(invalidateModule).toHaveBeenCalledWith(route, expect.any(Set));
    expect(invalidateModule).toHaveBeenCalledWith(split, expect.any(Set));
    expect(invalidateModule).toHaveBeenCalledTimes(2);
  });

  it("drops the update for a deleted file nothing imports any more", () => {
    const { result, invalidateModule } = run({ modules: [node(ROUTE)] });
    expect(result).toEqual([]);
    expect(invalidateModule).toHaveBeenCalledOnce();
  });

  it("leaves a deleted file that other modules still import to Vite", () => {
    const page = node("/app/src/routes/about.tsx");
    const component = node("/app/src/components/hero.tsx", [page]);
    const { result, invalidateModule } = run({
      file: "/app/src/components/hero.tsx",
      modules: [component],
    });
    expect(result).toBeUndefined();
    expect(invalidateModule).not.toHaveBeenCalled();
  });

  it("leaves edits and new files alone", () => {
    const routeTree = node("/app/src/routeTree.gen.ts");
    const modules = [node(ROUTE, [routeTree])];
    expect(run({ type: "update", modules }).result).toBeUndefined();
    expect(run({ type: "create", modules }).result).toBeUndefined();
  });
});

describe("skipDeletedRouteUpdates on a Vite dev server", () => {
  let root: string | undefined;
  let vite: ViteDevServer | undefined;
  afterEach(async () => {
    await vite?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Loads a route and a Tailwind stylesheet in the browser environment, as the
   * template does, deletes the route, and returns what Vite sent.
   */
  async function deleteRoute(plugins: Plugin[]): Promise<HotPayload[]> {
    root = mkdtempSync(path.join(tmpdir(), "skip-deleted-route-"));
    mkdirSync(path.join(root, "src/routes"), { recursive: true });
    const route = normalizePath(path.join(root, "src/routes/index.ts"));
    writeFileSync(path.join(root, "src/index.css"), '@import "tailwindcss";\n');
    writeFileSync(path.join(root, "src/routeTree.gen.ts"), 'import "./routes/index.ts";\n');
    // Accepts its own updates, as every TanStack route module does.
    writeFileSync(
      route,
      "export const page = \"<p class='text-balance'>Home</p>\";\nimport.meta.hot?.accept();\n",
    );

    vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [tailwindcss(), ...plugins],
      server: { middlewareMode: true },
    });
    const client = vite.environments.client;
    await client.transformRequest("/src/index.css?direct");
    await client.transformRequest("/src/routeTree.gen.ts");
    await client.transformRequest("/src/routes/index.ts");
    const modules = [...(client.moduleGraph.getModulesByFile(route) ?? [])];
    const mod = modules.find((m) => m.id !== null);
    expect(mod?.isSelfAccepting).toBe(true);
    // Tailwind scans the route for class names through a file-only entry.
    expect(modules.some((m) => m.id === null)).toBe(true);

    const sent: HotPayload[] = [];
    const send = client.hot.send.bind(client.hot);
    client.hot.send = ((payload: HotPayload) => {
      sent.push(payload);
      send(payload);
    }) as typeof client.hot.send;

    rmSync(route);
    await vi.waitUntil(() => mod?.transformResult === null, { timeout: 5000 });
    // Vite sends the update right after the hooks invalidate the module.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return sent;
  }

  const routeUpdate = (payload: HotPayload) =>
    payload.type === "update" && payload.updates.some((u) => u.path === "/src/routes/index.ts");

  it("tells the browser to re-import a deleted route without the plugin", async () => {
    expect((await deleteRoute([])).some(routeUpdate)).toBe(true);
  }, 10_000);

  it("sends no update for the deleted route with it, only the stylesheet's", async () => {
    const sent = await deleteRoute([skipDeletedRouteUpdates()]);
    expect(sent.some(routeUpdate)).toBe(false);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "update",
        updates: [expect.objectContaining({ path: "/src/index.css?direct" })],
      }),
    );
  }, 10_000);
});
