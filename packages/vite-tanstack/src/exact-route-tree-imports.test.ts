import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryHistory, createRouter, type AnyRoute } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  createServerModuleRunner,
  type DevEnvironment,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { exactRouteTreeImports } from "./exact-route-tree-imports";

const TREE_WITH_FERIA = `import { Route as rootRouteImport } from "./routes/__root";
import { Route as FeriaRouteImport } from "./routes/feria";
import { Route as FeriaIndexRouteImport } from "./routes/feria/index";
const FeriaRoute = FeriaRouteImport.update({ id: "/feria", path: "/feria", getParentRoute: () => rootRouteImport });
const FeriaIndexRoute = FeriaIndexRouteImport.update({ id: "/", path: "/", getParentRoute: () => FeriaRoute });
const FeriaRouteWithChildren = FeriaRoute._addFileChildren({ FeriaIndexRoute });
export const routeTree = rootRouteImport._addFileChildren({ FeriaRoute: FeriaRouteWithChildren });
`;

const TREE_WITHOUT_FERIA = `import { Route as rootRouteImport } from "../routes/__root";
import { Route as FeriaIndexRouteImport } from "../routes/feria/index";
const FeriaIndexRoute = FeriaIndexRouteImport.update({ id: "/feria/", path: "/feria/", getParentRoute: () => rootRouteImport });
export const routeTree = rootRouteImport._addFileChildren({ FeriaIndexRoute });
`;

describe("exactRouteTreeImports", () => {
  let root = "";
  let vite: ViteDevServer | undefined;

  beforeEach(() => {
    const tmp = path.join(import.meta.dirname, "../node_modules/.tmp");
    mkdirSync(tmp, { recursive: true });
    root = normalizePath(mkdtempSync(path.join(tmp, "route-tree-")));
    mkdirSync(path.join(root, "src/routes/feria"), { recursive: true });
    mkdirSync(path.join(root, "src/next"));
    writeFileSync(
      path.join(root, "src/routes/__root.ts"),
      'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute();\n',
    );
    writeFileSync(
      path.join(root, "src/routes/feria/index.ts"),
      'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/feria/")({});\n',
    );
    writeFileSync(path.join(root, "src/routeTree.gen.ts"), TREE_WITH_FERIA);
    writeFileSync(path.join(root, "src/next/routeTree.gen.ts"), TREE_WITHOUT_FERIA);
  });

  afterEach(async () => {
    await vite?.close();
    vite = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function serve(plugins: Plugin[]) {
    await vite?.close();
    vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins,
      server: { middlewareMode: true, ws: false },
    });
    return vite.environments.ssr;
  }

  const resolve = async (ssr: DevEnvironment, source: string, importer: string) =>
    (await ssr.pluginContainer.resolveId(source, `${root}/${importer}`))?.id;

  it("resolves the import of a deleted route to the route file, not its folder's index", async () => {
    const tree = "src/routeTree.gen.ts";
    expect(await resolve(await serve([]), "./routes/feria", tree)).toBe(
      `${root}/src/routes/feria/index.ts`,
    );
    expect(await resolve(await serve([exactRouteTreeImports()]), "./routes/feria", tree)).toBe(
      `${root}/src/routes/feria`,
    );
  });

  it("leaves other imports to Vite", async () => {
    const ssr = await serve([exactRouteTreeImports()]);
    const index = `${root}/src/routes/feria/index.ts`;
    expect(await resolve(ssr, "./routes/feria/index", "src/routeTree.gen.ts")).toBe(index);
    expect(await resolve(ssr, "./routes/feria", "src/app.ts")).toBe(index);
  });

  async function loadTrees(plugins: Plugin[]) {
    const runner = createServerModuleRunner(await serve(plugins), { hmr: false });
    try {
      const stale = await runner.import("/src/routeTree.gen.ts").then(
        () => "loaded",
        () => "failed",
      );
      const { routeTree } = await runner.import<{ routeTree: AnyRoute }>(
        "/src/next/routeTree.gen.ts",
      );
      return { stale, router: () => createRouter({ routeTree, history: createMemoryHistory() }) };
    } finally {
      await runner.close();
    }
  }

  it("keeps the rewritten route tree loadable after the stale one ran", async () => {
    const before = await loadTrees([]);
    expect(before.stale).toBe("loaded");
    expect(before.router).toThrow("Duplicate routes found with id: /feria/");

    const after = await loadTrees([exactRouteTreeImports()]);
    expect(after.stale).toBe("failed");
    expect(after.router).not.toThrow();
  });
});
