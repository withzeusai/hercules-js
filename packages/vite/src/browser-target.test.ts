import { writeFileSync } from "node:fs";
import path from "node:path";
import { appRoot } from "@usehercules/vite-common/testing";
import { build, resolveConfig } from "vite";
import type { Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { BROWSER_BUILD_TARGET } from "./browser-target";
import { hercules } from "./index";

const STATIC_BLOCK_LIB = `export class OrderedDict extends Map {
  static { Object.defineProperty(this, "name", { value: "OrderedDict" }); }
}
`;

function appWithStaticBlockDependency(): string {
  const root = appRoot({ collection: "*" }, { collection: { main: "index.js" } });
  writeFileSync(path.join(root, "node_modules/collection/index.js"), STATIC_BLOCK_LIB);
  writeFileSync(
    path.join(root, "main.js"),
    `import { OrderedDict } from "collection";\nconsole.log(new OrderedDict());\n`,
  );
  writeFileSync(path.join(root, "index.html"), `<script type="module" src="/main.js"></script>`);
  return root;
}

async function builtJs(root: string): Promise<string> {
  const output = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: hercules({ componentTagger: { enabled: false }, visualEditor: { enabled: false } }),
    build: { write: false },
  })) as Rolldown.RolldownOutput;
  return output.output
    .filter((file): file is Rolldown.OutputChunk => file.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
}

describe("browserTargetPlugin", () => {
  it("lowers a dependency's class static block in the build", async () => {
    const code = await builtJs(appWithStaticBlockDependency());
    expect(code).toContain("OrderedDict");
    expect(code).not.toMatch(/static\s*\{/);
  });

  it("lowers the browser JS target only", async () => {
    const config = { root: appRoot({}), configFile: false as const, environments: { ssr: {} } };
    const [vite, resolved] = await Promise.all([
      resolveConfig(config, "build"),
      resolveConfig({ ...config, plugins: hercules() }, "build"),
    ]);
    expect(resolved.environments.client!.build.target).toEqual(BROWSER_BUILD_TARGET);
    expect(resolved.environments.client!.build.cssTarget).toEqual(
      vite.environments.client!.build.cssTarget,
    );
    expect(resolved.environments.ssr!.build.target).toEqual(vite.environments.ssr!.build.target);
  });

  it("keeps a build target the app sets", async () => {
    const root = appRoot({});
    const resolved = await resolveConfig(
      { root, configFile: false, plugins: hercules(), build: { target: "es2022" } },
      "build",
    );
    expect(resolved.environments.client!.build.target).toBe("es2022");
  });
});
