import { EventEmitter } from "node:events";
import path from "node:path";
import { appRoot, lib } from "@usehercules/vite-common/testing";
import type { EnvironmentOptions, Plugin, UserConfig, ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hercules } from "./index";
import { optimizerEntriesPlugin, prebundleDependenciesPlugin } from "./prebundle";

type ConfigHook = (config: UserConfig) => UserConfig | undefined;
type ConfigEnvironmentHook = (
  name: string,
  config: EnvironmentOptions,
) => EnvironmentOptions | undefined;

function config(plugin: Plugin, userConfig: UserConfig = {}) {
  return (plugin.config as unknown as ConfigHook)(userConfig);
}

function configEnvironment(plugin: Plugin, name: string, options: EnvironmentOptions = {}) {
  return (plugin.configEnvironment as unknown as ConfigEnvironmentHook)(name, options);
}

function fakeServer() {
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
  const server = {
    watcher,
    restart: vi.fn(() => new Promise<void>(() => {})),
    config: { logger: { info: vi.fn() } },
    httpServer: new EventEmitter(),
    ws: { send: vi.fn() },
    environments: { client: { hot: { send: vi.fn() } } },
  } as unknown as ViteDevServer;
  return { server, watcher };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hercules", () => {
  it("adds the tagger, the visual editor endpoints and the optimizer plugins", () => {
    expect(hercules().map((plugin) => plugin.name)).toEqual([
      "vite-plugin-hercules-component-tagger",
      "vite-plugin-hercules-visual-editor",
      "vite-plugin-hercules",
      "vite-plugin-hercules-prebundle-dependencies",
    ]);
  });

  it("keeps the source crawl when dependency pre-bundling is off", () => {
    const names = hercules({ prebundleDependencies: false }).map((plugin) => plugin.name);
    expect(names).toContain("vite-plugin-hercules");
    expect(names).not.toContain("vite-plugin-hercules-prebundle-dependencies");
  });

  it("runs only on the dev server", () => {
    for (const plugin of hercules()) expect(plugin.apply).toBe("serve");
  });
});

describe("optimizerEntriesPlugin", () => {
  it("crawls src without server modules or tests, plus every HTML entry", () => {
    expect(config(optimizerEntriesPlugin())?.optimizeDeps?.entries).toEqual([
      "**/*.html",
      "src/**/*.{js,jsx,ts,tsx,mjs,mts}",
      "!src/**/*.d.{ts,mts}",
      "!src/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}",
      "!src/**/__tests__/**",
      "!src/**/__mocks__/**",
      "!src/**/*.server.{js,jsx,ts,tsx,mjs,mts}",
      "!src/server/**",
    ]);
  });

  it.each([
    ["app/main.ts", ["app/main.ts"]],
    [
      ["app/a.ts", "app/b.ts"],
      ["app/a.ts", "app/b.ts"],
    ],
    [{ main: "app/main.ts", admin: "admin.html" }, ["app/main.ts", "admin.html"]],
  ])("keeps the configured build input %j", (input, entries) => {
    const result = config(optimizerEntriesPlugin(), { build: { rollupOptions: { input } } });
    expect(result?.optimizeDeps?.entries?.slice(0, entries.length)).toEqual(entries);
  });
});

describe("prebundleDependenciesPlugin", () => {
  function plugin(root: string): Plugin {
    const prebundle = prebundleDependenciesPlugin();
    config(prebundle, { root });
    return prebundle;
  }

  it("runs after the other plugins, so their excludes are known", () => {
    expect(prebundleDependenciesPlugin().enforce).toBe("post");
  });

  it("bundles the app's dependencies in the browser, without React or excluded ones", () => {
    const root = appRoot(
      { react: "*", "react-dom": "*", papaparse: "*", zod: "*", "excluded-lib": "*" },
      { react: lib, "react-dom": lib, papaparse: lib, zod: lib, "excluded-lib": lib },
    );
    const result = configEnvironment(plugin(root), "client", {
      optimizeDeps: { exclude: ["excluded-lib"] },
    });
    expect(result?.optimizeDeps?.include).toEqual(["papaparse", "zod"]);
  });

  it("leaves other environments alone", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    expect(configEnvironment(plugin(root), "ssr")).toBeUndefined();
  });

  it("restarts on dependency changes only on the Hercules dev machine", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });

    const local = fakeServer();
    (plugin(root).configureServer as (server: ViteDevServer) => void)(local.server);
    expect(local.watcher.add).not.toHaveBeenCalled();

    vi.stubEnv("HERCULES_DEV_MACHINE", "1");
    const machine = fakeServer();
    (plugin(root).configureServer as (server: ViteDevServer) => void)(machine.server);
    expect(machine.watcher.add).toHaveBeenCalledWith(
      expect.arrayContaining([path.join(root, "package.json")]),
    );
  });
});
