import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, normalizePath, type Plugin, type ViteDevServer } from "vite";
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

const SHARED = "/src/routes/index.tsx?tsr-shared=1";
const SPLIT = "/src/routes/index.tsx?tsr-split=component";

describe("compileRouteFileFirst", () => {
  let root = "";
  let vite: ViteDevServer | undefined;

  beforeEach(() => {
    const tmp = path.join(import.meta.dirname, "../node_modules/.tmp");
    mkdirSync(tmp, { recursive: true });
    root = normalizePath(mkdtempSync(path.join(tmp, "split-order-")));
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
        {
          name: "count-route-compiles",
          transform(_code, id) {
            if (id === `${root}/src/routes/index.tsx`) compiles.count++;
          },
        },
      ],
      server: { middlewareMode: true, ws: false },
    });
    return { environments: vite.environments, compiles };
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
});
