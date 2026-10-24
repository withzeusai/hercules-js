import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentOptions, Plugin, ViteDevServer } from "vite";
import {
  PREBUNDLED_ENTRIES,
  dependenciesToPrebundle,
  onlyDeclared,
  packageNameOf,
  prebundleDependencies,
  sourceEntries,
  type PrebundleOptions,
} from "./prebundle";

/** A project root with a package.json and the given installed packages. */
function appRoot(
  dependencies: Record<string, string>,
  installed: Record<string, Record<string, unknown>> = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), "vite-tanstack-prebundle-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies }));
  for (const [name, manifest] of Object.entries(installed)) install(root, name, manifest);
  return root;
}

function install(root: string, name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
}

function declare(root: string, dependencies: Record<string, string>): void {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies }));
}

const lib = { main: "index.js" };

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

describe("packageNameOf", () => {
  it.each([
    ["clsx", "clsx"],
    ["convex/react", "convex"],
    ["motion/react", "motion"],
    ["@hookform/resolvers/zod", "@hookform/resolvers"],
    ["@tanstack/react-router > @tanstack/react-store", "@tanstack/react-router"],
  ])("maps %s to %s", (entry, name) => {
    expect(packageNameOf(entry)).toBe(name);
  });
});

describe("onlyDeclared", () => {
  it("keeps every entry when package.json cannot be read", () => {
    expect(onlyDeclared(["clsx", "zod"], undefined)).toEqual(["clsx", "zod"]);
  });

  it("drops entries whose package the app does not declare", () => {
    expect(onlyDeclared(["clsx", "convex/react", "zod"], new Set(["convex", "zod"]))).toEqual([
      "convex/react",
      "zod",
    ]);
  });
});

describe("dependenciesToPrebundle", () => {
  it("keeps installed runtime dependencies that load JavaScript", () => {
    const root = appRoot(
      { papaparse: "*", zod: "*", clsx: "*", "lib-noext": "*", "lib-index": "*" },
      {
        papaparse: { main: "papaparse.min.js" },
        zod: { exports: { ".": { types: "./index.d.ts", import: "./index.js" } } },
        clsx: { exports: { import: "./dist/clsx.mjs", default: "./dist/clsx.js" } },
        "lib-noext": { main: "lib/index" },
        "lib-index": {},
      },
    );
    writeFileSync(path.join(root, "node_modules/lib-index/index.js"), "");
    expect(dependenciesToPrebundle(root)).toEqual([
      "clsx",
      "lib-index",
      "lib-noext",
      "papaparse",
      "zod",
    ]);
  });

  it("leaves out packages the optimizer cannot or must not bundle", () => {
    const root = appRoot(
      {
        react: "*",
        "react-dom": "*",
        "@tanstack/react-start": "*",
        "@tanstack/react-router": "*",
        "@types/papaparse": "*",
        "@fontsource-variable/geist": "*",
        "subpaths-only": "*",
        "native-gyp": "*",
        "native-loader": "*",
        sharp: "*",
        "not-installed": "*",
      },
      {
        react: lib,
        "react-dom": lib,
        "@tanstack/react-start": lib,
        "@tanstack/react-router": lib,
        "@types/papaparse": { types: "index.d.ts" },
        "@fontsource-variable/geist": { main: "index.css", exports: { ".": "./index.css" } },
        "subpaths-only": { exports: { "./client": "./client.js" } },
        "native-gyp": { main: "index.js", gypfile: true },
        "native-loader": { main: "index.js", dependencies: { "node-gyp-build": "*" } },
        sharp: { main: "lib/index.js", optionalDependencies: { "@img/sharp-linux-x64": "*" } },
      },
    );
    expect(dependenciesToPrebundle(root)).toEqual([]);
  });

  it("leaves out a package a project-root file shadows", () => {
    const root = appRoot({ convex: "*", zod: "*" }, { convex: lib, zod: lib });
    writeFileSync(path.join(root, "convex.json"), "{}");
    expect(dependenciesToPrebundle(root)).toEqual(["zod"]);
  });

  it("ignores devDependencies", () => {
    const root = appRoot({}, { vitest: lib });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: {}, devDependencies: { vitest: "*" } }),
    );
    expect(dependenciesToPrebundle(root)).toEqual([]);
  });

  it("returns nothing when package.json cannot be read", () => {
    expect(dependenciesToPrebundle(path.join(tmpdir(), "does-not-exist"))).toEqual([]);
  });
});

describe("sourceEntries", () => {
  it("scans the source tree without tests or type declarations", () => {
    expect(sourceEntries("app/")).toEqual([
      "app/**/*.{js,jsx,ts,tsx,mjs,mts}",
      "!app/**/*.d.{ts,mts}",
      "!app/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}",
      "!app/**/__tests__/**",
      "!app/**/__mocks__/**",
    ]);
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
    finishRestart: (replaced: boolean) => void;
    wsSend: ReturnType<typeof vi.fn>;
    hotSend: ReturnType<typeof vi.fn>;
  }

  function fakeServer(): FakeServer {
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
    const wsSend = vi.fn();
    const hotSend = vi.fn();
    let finish: () => void = () => {};
    const server = {
      watcher,
      config: { logger: { info: vi.fn() } },
      httpServer: new EventEmitter(),
      ws: { send: wsSend },
      environments: { client: { hot: { send: hotSend } } },
    } as unknown as ViteDevServer & { environments: object };
    const restart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(server, { restart });
    const finishRestart = (replaced: boolean) => {
      // A successful restart swaps in the new server's environments.
      if (replaced) Object.assign(server, { environments: {} });
      finish();
    };
    return { server, watcher, restart, finishRestart, wsSend, hotSend };
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

  it("watches package.json and the lockfiles", () => {
    const root = appRoot({});
    const { watcher } = start(root);
    expect(watcher.add).toHaveBeenCalledWith(
      expect.arrayContaining([path.join(root, "package.json"), path.join(root, "pnpm-lock.yaml")]),
    );
  });

  it("restarts once a newly installed package can be bundled", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const { watcher, restart } = start(root);

    install(root, "papaparse", lib);
    declare(root, { zod: "*", papaparse: "*" });
    watcher.emit("change", path.join(root, "package.json"));
    watcher.emit("change", path.join(root, "pnpm-lock.yaml"));
    vi.advanceTimersByTime(999);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledTimes(1);

    watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(5000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for a declared package to be linked", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const { watcher, restart } = start(root);

    declare(root, { zod: "*", papaparse: "*" });
    watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(3000);
    expect(restart).not.toHaveBeenCalled();

    install(root, "papaparse", lib);
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart for changes that leave the bundled set alone", () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const { watcher, restart } = start(root);

    install(root, "@fontsource-variable/geist", { main: "index.css" });
    declare(root, { zod: "*", "@fontsource-variable/geist": "*" });
    watcher.emit("change", path.join(root, "package.json"));
    watcher.emit("change", path.join(root, "src/routes/index.tsx"));
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts when a bundled dependency is removed", () => {
    const root = appRoot({ zod: "*", papaparse: "*" }, { zod: lib, papaparse: lib });
    const { watcher, restart } = start(root);

    declare(root, { zod: "*" });
    watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("mutes the old server's HMR messages while it restarts", async () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const fake = start(root);
    const { ws, environments } = fake.server;

    install(root, "papaparse", lib);
    declare(root, { zod: "*", papaparse: "*" });
    fake.watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(1000);
    expect(fake.restart).toHaveBeenCalledOnce();

    ws.send({ type: "full-reload", path: "*" });
    environments.client!.hot.send({ type: "full-reload", path: "*" });
    expect(fake.wsSend).not.toHaveBeenCalled();
    expect(fake.hotSend).not.toHaveBeenCalled();

    fake.finishRestart(true);
    await vi.runAllTimersAsync();
    ws.send({ type: "full-reload", path: "*" });
    expect(fake.wsSend).not.toHaveBeenCalled();
  });

  it("gives the old server its HMR messages back when the restart fails", async () => {
    const root = appRoot({ zod: "*" }, { zod: lib });
    const fake = start(root);

    declare(root, {});
    fake.watcher.emit("change", path.join(root, "package.json"));
    vi.advanceTimersByTime(1000);
    expect(fake.restart).toHaveBeenCalledOnce();

    fake.finishRestart(false);
    await vi.runAllTimersAsync();
    fake.server.ws.send({ type: "full-reload", path: "*" });
    fake.server.environments.client!.hot.send({ type: "full-reload", path: "*" });
    expect(fake.wsSend).toHaveBeenCalledOnce();
    expect(fake.hotSend).toHaveBeenCalledOnce();
  });

  it("does not watch when dependency bundling is off", () => {
    const root = appRoot({});
    const { watcher } = start(root, { dependencies: false });
    expect(watcher.add).not.toHaveBeenCalled();
  });
});
