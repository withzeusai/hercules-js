import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentOptions, Plugin, ViteDevServer } from "vite";
import { packageNameOf, sourceEntries } from "@usehercules/vite-common";
import { appRoot, declare, install, lib } from "@usehercules/vite-common/testing";
import {
  PREBUNDLED_ENTRIES,
  dependenciesToPrebundle,
  prebundleDependencies,
  type PrebundleOptions,
} from "./prebundle";

type ConfigEnvironmentHook = (
  name: string,
  config: EnvironmentOptions,
) => EnvironmentOptions | undefined;

function configEnvironment(plugin: Plugin, name: string, config: EnvironmentOptions = {}) {
  return (plugin.configEnvironment as unknown as ConfigEnvironmentHook)(name, config);
}

function options(root: string, overrides: Partial<PrebundleOptions> = {}): PrebundleOptions {
  return { root, srcDir: "src", dependencies: true, extra: [], ...overrides };
}

describe("dependenciesToPrebundle", () => {
  it("leaves out React and the TanStack packages Start loads from source", () => {
    const root = appRoot(
      {
        react: "*",
        "react-dom": "*",
        "@tanstack/react-start": "*",
        "@tanstack/react-router": "*",
        "@tanstack/react-router-devtools": "*",
        zod: "*",
      },
      {
        react: lib,
        "react-dom": lib,
        "@tanstack/react-start": lib,
        "@tanstack/react-router": lib,
        "@tanstack/react-router-devtools": lib,
        zod: lib,
      },
    );
    expect(dependenciesToPrebundle(root)).toEqual(["zod"]);
  });
});

describe("prebundleDependencies", () => {
  const templateDependencies = Object.fromEntries(
    PREBUNDLED_ENTRIES.map((entry) => [packageNameOf(entry), "*"]),
  );

  it("runs only on the dev server, after the framework plugins", () => {
    const plugin = prebundleDependencies(options(appRoot({})));
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("post");
  });

  it("bundles the dependencies and the declared template entries in the browser", () => {
    const root = appRoot({ ...templateDependencies, papaparse: "*" }, { papaparse: lib });
    const result = configEnvironment(prebundleDependencies(options(root)), "client");
    expect(result?.optimizeDeps?.include).toEqual(["papaparse", ...PREBUNDLED_ENTRIES]);
    expect(result?.optimizeDeps?.entries).toBeUndefined();
  });

  it("adds the server entries and a source scan in the Worker", () => {
    const root = appRoot({ convex: "*", papaparse: "*" }, { papaparse: lib });
    const result = configEnvironment(
      prebundleDependencies(options(root, { srcDir: "app" })),
      "ssr",
    );
    expect(result?.optimizeDeps?.include).toEqual([
      "papaparse",
      "convex/react",
      "convex/server",
      "convex/values",
      "convex/browser",
    ]);
    expect(result?.optimizeDeps?.entries).toEqual(sourceEntries("app"));
  });

  it("leaves other environments alone", () => {
    const plugin = prebundleDependencies(options(appRoot({ papaparse: "*" }, { papaparse: lib })));
    expect(configEnvironment(plugin, "rsc")).toBeUndefined();
  });

  it("drops what another plugin excludes, by entry or by package", () => {
    const root = appRoot(
      { "@tanstack/react-router": "*", papaparse: "*", "start-lib": "*" },
      { papaparse: lib, "start-lib": lib },
    );
    const result = configEnvironment(prebundleDependencies(options(root)), "client", {
      optimizeDeps: { exclude: ["@tanstack/react-router", "start-lib"] },
    });
    expect(result?.optimizeDeps?.include).toEqual(["papaparse"]);
  });

  it("adds the extra entries, and only those when dependencies are off", () => {
    const root = appRoot({ papaparse: "*" }, { papaparse: lib });
    const result = configEnvironment(
      prebundleDependencies(options(root, { dependencies: false, extra: ["lodash/debounce"] })),
      "client",
    );
    expect(result?.optimizeDeps?.include).toEqual(["lodash/debounce"]);
  });
});

describe("restart on dependency changes", () => {
  interface FakeServer {
    server: ViteDevServer;
    watcher: EventEmitter & { add: ReturnType<typeof vi.fn> };
    restart: ReturnType<typeof vi.fn>;
  }

  function fakeServer(): FakeServer {
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
    const restart = vi.fn(() => new Promise<void>(() => {}));
    const server = {
      watcher,
      restart,
      config: { logger: { info: vi.fn() } },
      httpServer: new EventEmitter(),
      ws: { send: vi.fn() },
      environments: { client: { hot: { send: vi.fn() } } },
    } as unknown as ViteDevServer;
    return { server, watcher, restart };
  }

  function start(root: string, overrides: Partial<PrebundleOptions> = {}): FakeServer {
    const plugin = prebundleDependencies(options(root, overrides));
    configEnvironment(plugin, "client");
    const fake = fakeServer();
    (plugin.configureServer as (server: ViteDevServer) => void)(fake.server);
    return fake;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts once a newly installed package can be bundled", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const { watcher, restart } = start(root);
    expect(watcher.add).toHaveBeenCalledWith(
      expect.arrayContaining([path.join(root, "package.json"), path.join(root, "pnpm-lock.yaml")]),
    );

    install(root, "papaparse", lib);
    declare(root, { zod: "*", papaparse: "*" });
    watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not watch when dependency bundling is off", () => {
    const root = appRoot({});
    const { watcher } = start(root, { dependencies: false });
    expect(watcher.add).not.toHaveBeenCalled();
  });
});
