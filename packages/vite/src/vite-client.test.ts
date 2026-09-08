import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { ERROR_HANDLER_MODULE_ID, hercules } from "./index";
import { VISUAL_EDITOR_MODULE_ID } from "./visual-editor";
import { appendClientImport, isClientTransform, isViteClientModule } from "./vite-client";

const VITE_CLIENT_ID = "/app/node_modules/vite/dist/client/client.mjs";

type Hook<K extends keyof Plugin> = Extract<Plugin[K], (...args: never[]) => unknown>;

function plugin(name: string): Plugin {
  const found = hercules({ debug: false }).find((p) => p.name === name);
  if (!found) throw new Error(`plugin ${name} not registered`);
  return found;
}

/** Simulate the dev server: `configResolved` runs before any transform. */
function serve(p: Plugin): Plugin {
  (p.configResolved as Hook<"configResolved">).call(
    {} as never,
    { command: "serve", root: "/app" } as never,
  );
  return p;
}

function transform(p: Plugin, code: string, id: string, env = "client"): unknown {
  return (p.transform as Hook<"transform">).call(
    { environment: { name: env } } as never,
    code,
    id,
    undefined,
  );
}

describe("vite-client helpers", () => {
  it("recognises Vite's dev client on any platform", () => {
    expect(isViteClientModule(VITE_CLIENT_ID)).toBe(true);
    expect(isViteClientModule("C:\\app\\node_modules\\vite\\dist\\client\\client.mjs")).toBe(true);
    expect(isViteClientModule("/app/src/main.tsx")).toBe(false);
  });

  it("only targets the client environment", () => {
    expect(isClientTransform({ environment: { name: "client" } })).toBe(true);
    expect(isClientTransform({ environment: { name: "ssr" } })).toBe(false);
    expect(isClientTransform({}, { ssr: true })).toBe(false);
    expect(isClientTransform({})).toBe(true);
  });

  it("appends a dynamic import", () => {
    expect(appendClientImport("const a = 1;", "virtual:x")).toEqual({
      code: 'const a = 1;\nimport("virtual:x");\n',
      map: null,
    });
  });
});

describe("hercules error handler injection", () => {
  it("imports the error handler from the Vite client in dev", () => {
    const p = serve(plugin("vite-plugin-hercules"));
    expect(transform(p, "// vite client", VITE_CLIENT_ID)).toEqual({
      code: `// vite client\nimport(${JSON.stringify(ERROR_HANDLER_MODULE_ID)});\n`,
      map: null,
    });
  });

  it("leaves other modules and the ssr environment alone", () => {
    const p = serve(plugin("vite-plugin-hercules"));
    expect(transform(p, "x", "/app/src/main.tsx")).toBeNull();
    expect(transform(p, "x", VITE_CLIENT_ID, "ssr")).toBeNull();
  });

  it("serves the guarded script through the virtual module", () => {
    const p = plugin("vite-plugin-hercules");
    const resolved = (p.resolveId as Hook<"resolveId">).call(
      {} as never,
      ERROR_HANDLER_MODULE_ID,
      undefined,
      {} as never,
    );
    expect(resolved).toBe(`\0${ERROR_HANDLER_MODULE_ID}`);
    const code = (p.load as Hook<"load">).call({} as never, resolved as string, undefined);
    expect(code).toContain("__herculesErrorHandlerInstalled");
  });
});

describe("visual editor injection", () => {
  it("imports the editor from the Vite client and serves a guarded script", () => {
    const p = plugin("vite-plugin-hercules-visual-editor");
    expect(transform(p, "// vite client", VITE_CLIENT_ID)).toEqual({
      code: `// vite client\nimport(${JSON.stringify(VISUAL_EDITOR_MODULE_ID)});\n`,
      map: null,
    });
    expect(transform(p, "x", VITE_CLIENT_ID, "ssr")).toBeNull();

    const resolved = (p.resolveId as Hook<"resolveId">).call(
      {} as never,
      VISUAL_EDITOR_MODULE_ID,
      undefined,
      {} as never,
    );
    const code = (p.load as Hook<"load">).call({} as never, resolved as string, undefined);
    expect(code).toContain("__herculesVisualEditorInstalled");
    expect(code).toContain("data-hercules-id");
  });
});
