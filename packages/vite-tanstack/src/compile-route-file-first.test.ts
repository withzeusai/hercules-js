import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  normalizePath,
  type HotPayload,
  type Plugin,
  type PluginOption,
  type ViteDevServer,
} from "vite";
import { compileRouteFileFirst } from "./compile-route-file-first";

// The shape from TanStack/router#8754: a query used by both the loader, which
// stays in the route file, and the component, which is split out.
const ROUTE = `import { createFileRoute } from "@tanstack/react-router";
const visitsQuery = { queryKey: ["visits"], count: 0 };
export const Route = createFileRoute("/")({
  loader: () => ++visitsQuery.count,
  component: () => "visits: " + visitsQuery.count,
});
`;

// The same route after an edit that makes the loader and the component share
// one more value.
const EDITED = ROUTE.replace("const visitsQuery", 'const HEADING = "Visits";\nconst visitsQuery')
  .replace("++visitsQuery.count", "HEADING + ++visitsQuery.count")
  .replace('"visits: " + visitsQuery.count', "HEADING + visitsQuery.count");

const SHARED = "/src/routes/index.tsx?tsr-shared=1";
const SPLIT = "/src/routes/index.tsx?tsr-split=component";

// Bundling dependencies is not needed here, and can write to the cache after
// the server closes.
const noDependencyBundling: Plugin = {
  name: "no-dependency-bundling",
  configEnvironment: {
    order: "post",
    handler(_name, config) {
      config.optimizeDeps = { ...config.optimizeDeps, noDiscovery: true, include: [] };
    },
  },
};

describe("compileRouteFileFirst", () => {
  let root = "";
  let vite: ViteDevServer | undefined;

  beforeEach(() => {
    // Outside node_modules, where Vite would skip hot updates for the app.
    root = normalizePath(realpathSync(mkdtempSync(path.join(tmpdir(), "split-order-"))));
    symlinkSync(path.join(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"));
    mkdirSync(path.join(root, "src/routes"), { recursive: true });
    writeFileSync(
      path.join(root, "src/routes/__root.tsx"),
      'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute();\n',
    );
    writeFileSync(path.join(root, "src/routes/index.tsx"), ROUTE);
    writeFileSync(
      path.join(root, "src/router.tsx"),
      'import { createRouter } from "@tanstack/react-router";\nimport { routeTree } from "./routeTree.gen";\nexport const getRouter = () => createRouter({ routeTree });\n',
    );
  });

  afterEach(async () => {
    await vite?.close();
    vite = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh dev server, counting how often the route file is compiled. */
  async function serve(plugins: Plugin[]) {
    const compiles = { count: 0 };
    vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        ...plugins,
        tanstackStart(),
        react(),
        noDependencyBundling,
        {
          name: "count-route-compiles",
          transform(_code, id) {
            if (id === `${root}/src/routes/index.tsx`) compiles.count++;
          },
        },
      ],
      server: { middlewareMode: true, ws: false },
    });
    return { vite, environments: vite.environments, compiles };
  }

  it("is needed until TanStack/router#8754 is fixed: a shared module compiled first is the whole route file", async () => {
    const { environments } = await serve([]);
    const shared = await environments.client.transformRequest(SHARED);
    const split = await environments.client.transformRequest(SPLIT);
    expect(shared?.code).toContain("createFileRoute");
    expect(split?.code).toContain("const visitsQuery");
  });

  it.each(["client", "ssr"])(
    "compiles the route file before a shared module or split chunk requested first (%s)",
    async (name) => {
      const { environments, compiles } = await serve([compileRouteFileFirst()]);
      const env = environments[name]!;
      const [shared, split] = await Promise.all([
        env.transformRequest(SHARED),
        env.transformRequest(SPLIT),
      ]);

      // Only the shared module declares the query; the others import it.
      expect(shared?.code).not.toContain("createFileRoute");
      expect(shared?.code).toContain("const visitsQuery");
      expect(split?.code).toContain(SHARED);
      expect(split?.code).not.toContain("const visitsQuery");

      // The route file is compiled once and cached for the page's own request.
      const route = await env.transformRequest("/src/routes/index.tsx");
      expect(route?.code).toContain(SHARED);
      expect(route?.code).not.toContain("const visitsQuery");
      expect(compiles.count).toBe(1);
    },
  );

  // In the browser, an edit to a route file hot-updates the route file and its
  // split chunk at the same time. If the chunk is compiled first, it imports
  // the shared module with the bindings from before the edit.
  it("compiles an edited route file before its hot-updated split chunk", async () => {
    const { vite, environments } = await serve([compileRouteFileFirst()]);
    const client = environments.client;
    for (const url of ["/src/routeTree.gen.ts", "/src/routes/index.tsx", SHARED, SPLIT]) {
      await client.transformRequest(url);
    }

    const updates = new Promise<string[]>((resolve) => {
      client.hot.send = ((payload: HotPayload) => {
        if (payload.type === "update") resolve(payload.updates.map((u) => u.acceptedPath));
      }) as typeof client.hot.send;
    });
    const file = path.join(root, "src/routes/index.tsx");
    writeFileSync(file, EDITED);
    vite.watcher.emit("change", file);
    expect((await updates).sort()).toEqual(["/src/routes/index.tsx", SPLIT]);

    // The split chunk and its import arrive before the route file.
    await client.transformRequest(SPLIT);
    const shared = await client.transformRequest(SHARED);
    const route = await client.transformRequest("/src/routes/index.tsx");
    expect(route?.code).toMatch(/import \{ HEADING, visitsQuery \} from/);
    expect(shared?.code).toMatch(/export \{ HEADING, visitsQuery \}/);
  });

  // Adding a dependency restarts the dev server, which loads the config again,
  // so the code splitter starts over with no shared bindings. A browser that
  // still holds the route file can ask the new server for the shared module
  // first.
  it.each([
    ["the whole route file without the plugin", false],
    ["only the shared values with the plugin", true],
  ])("serves a shared module requested first after a restart: %s", async (_, withPlugin) => {
    const scope = globalThis as { routeOrderPlugins?: () => PluginOption[] };
    scope.routeOrderPlugins = () => [
      ...(withPlugin ? [compileRouteFileFirst()] : []),
      tanstackStart(),
      react(),
    ];
    const configFile = path.join(root, "vite.config.mjs");
    writeFileSync(configFile, "export default { plugins: globalThis.routeOrderPlugins() };\n");
    vite = await createServer({
      root,
      configFile,
      logLevel: "silent",
      plugins: [noDependencyBundling],
      server: { middlewareMode: true, ws: false },
    });
    for (const url of ["/src/routes/index.tsx", SHARED]) {
      await vite.environments.client.transformRequest(url);
    }

    await vite.restart();
    const shared = await vite.environments.client.transformRequest(SHARED);
    delete scope.routeOrderPlugins;
    expect(shared?.code.includes("createFileRoute")).toBe(!withPlugin);
  });
});
