import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import {
  HERCULES_STARTUP_PROFILE_ENV,
  STARTUP_PROFILE_PREFIX,
  startupProfileFromEnv,
  startupProfiler,
  type StartupProfileReport,
} from "./startup-profile";

type Middleware = (req: object, res: EventEmitter, next: () => void) => void;

interface OptimizerTimer {
  buildStart(): void;
  buildEnd(): void;
  renderStart(): void;
  writeBundle(): void;
}

const IDLE_CHECK_MS = 500;
const DEADLINE_MS = 60_000;

/** A profiler on a clock the test moves, with scheduled callbacks held for the test to run. */
function setup() {
  let time = 1000;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const lines: string[] = [];
  const profiler = startupProfiler({
    root: "/nonexistent",
    now: () => time,
    write: (line) => lines.push(line),
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  });
  const advance = (ms: number) => {
    time += ms;
  };
  /** Runs the callbacks scheduled with `delayMs`, or all of them. */
  const runScheduled = (delayMs?: number) => {
    const due = scheduled.filter((entry) => delayMs === undefined || entry.delayMs === delayMs);
    for (const entry of due) scheduled.splice(scheduled.indexOf(entry), 1);
    for (const { callback } of due) callback();
  };
  const reports = () =>
    lines.map((line) => {
      expect(line.startsWith(`${STARTUP_PROFILE_PREFIX} `)).toBe(true);
      return JSON.parse(line.slice(STARTUP_PROFILE_PREFIX.length + 1)) as StartupProfileReport;
    });
  return { profiler, advance, scheduled, runScheduled, reports };
}

/** Runs the reporter's hooks against a stand-in dev server. */
function startServer(reporter: Plugin) {
  let middleware: Middleware | undefined;
  const httpServer = new EventEmitter();
  const server = {
    httpServer,
    config: { logger: { info: vi.fn() } },
    middlewares: {
      use: (fn: Middleware) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer;
  const configEnvironment = reporter.configEnvironment as unknown as (name: string) => {
    optimizeDeps: { rolldownOptions: { plugins: OptimizerTimer[] } };
  };
  const optimizer = (env: string) =>
    configEnvironment(env).optimizeDeps.rolldownOptions.plugins[0]!;
  (reporter.configResolved as (config: ResolvedConfig) => void)({
    environments: {
      client: { optimizeDeps: { include: ["a", "b"] } },
      ssr: { optimizeDeps: { include: ["a"] } },
    },
  } as unknown as ResolvedConfig);
  (reporter.configureServer as (server: ViteDevServer) => void)(server);

  const request = (url: string, accept = "*/*") => {
    const next = vi.fn();
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    middleware!({ method: "GET", url, headers: { accept } }, res, next);
    return {
      next,
      finish: () => {
        res.writableFinished = true;
        res.emit("finish");
      },
    };
  };
  return { httpServer, optimizer, request };
}

describe("startupProfileFromEnv", () => {
  it.each([
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["0", false],
    ["false", false],
    [undefined, undefined],
    ["", undefined],
    ["yes", undefined],
  ])("reads %j as %j", (value, expected) => {
    expect(startupProfileFromEnv({ [HERCULES_STARTUP_PROFILE_ENV]: value })).toBe(expected);
  });
});

describe("startupProfiler", () => {
  it("times hooks without changing what they return or the `this` they see", async () => {
    const { profiler } = setup();
    const context = { marker: true };
    // Typed loosely so `configResolved` can hand back the `this` it was called with.
    const plugin = {
      name: "sync-and-async",
      configResolved(this: unknown) {
        return this;
      },
      async configureServer() {
        return undefined;
      },
      transform: { order: "pre", filter: { id: /\.ts$/ }, handler: (code: string) => `${code}!` },
    } as unknown as Plugin;
    const [reporter, wrapped] = await profiler.instrument([[plugin]]);

    expect(reporter?.name).toBe("hercules:startup-profile");
    expect(wrapped).toBe(plugin);
    expect((plugin.configResolved as (this: unknown) => unknown).call(context)).toBe(context);
    await expect((plugin.configureServer as () => Promise<unknown>)()).resolves.toBeUndefined();
    const transform = plugin.transform as {
      order: string;
      filter: unknown;
      handler: (code: string) => string;
    };
    expect(transform.order).toBe("pre");
    expect(transform.filter).toEqual({ id: /\.ts$/ });
    expect(transform.handler("x")).toBe("x!");
  });

  it("rethrows a hook's error", async () => {
    const { profiler } = setup();
    const plugin: Plugin = {
      name: "throws",
      configResolved() {
        throw new Error("sync");
      },
      async buildStart() {
        throw new Error("async");
      },
    };
    await profiler.instrument([plugin]);
    expect(() => (plugin.configResolved as () => void)()).toThrow("sync");
    await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow("async");
  });

  it("reports once the first page is served and the optimizer is idle", async () => {
    const { profiler, advance, runScheduled, reports } = setup();
    const cloudflare: Plugin = {
      name: "vite-plugin-cloudflare",
      async configureServer() {
        advance(3000);
        return () => advance(5);
      },
      transform: () => {
        advance(40);
        return null;
      },
    };
    await profiler.step("@cloudflare/vite-plugin", async () => advance(400));
    const [reporter] = await profiler.instrument([cloudflare]);
    const { httpServer, optimizer, request } = startServer(reporter!);

    const post = await (cloudflare.configureServer as () => Promise<() => void>)();
    post();
    advance(100);
    httpServer.emit("listening");

    const client = optimizer("client");
    client.buildStart();
    advance(200);
    client.buildEnd();
    client.renderStart();
    advance(300);

    expect(request("/@vite/client").next).toHaveBeenCalledOnce();
    const page = request("/");
    (cloudflare.transform as () => void)();
    advance(1000);
    page.finish();
    runScheduled(IDLE_CHECK_MS);
    expect(reports()).toEqual([]);

    client.writeBundle();
    runScheduled(IDLE_CHECK_MS);
    expect(reports()).toEqual([
      {
        v: 1,
        start: expect.any(Number),
        versions: {},
        marks: { configLoad: 1000, pluginsReady: 1400, configResolved: 1400, listening: 4505 },
        imports: { "@cloudflare/vite-plugin": 400 },
        include: { client: 2, ssr: 1 },
        optimizer: [{ env: "client", kind: "bundle", at: 4505, ms: 1540 }],
        hooks: [
          ["vite-plugin-cloudflare", "configureServer", 3000],
          ["vite-plugin-cloudflare", "configureServer:post", 5],
        ],
        modules: [["vite-plugin-cloudflare", "transform", 1, 40]],
        firstPage: { at: 5005, ms: 1040, status: 200, completed: true },
      },
    ]);
  });

  it("keeps a run that ends without writing a bundle as a scan", async () => {
    const { profiler, advance, runScheduled, reports } = setup();
    const [reporter] = await profiler.instrument([]);
    const { optimizer, request } = startServer(reporter!);
    const ssr = optimizer("ssr");
    ssr.buildStart();
    advance(250);
    ssr.buildEnd();
    request("/", "text/html").finish();
    runScheduled(IDLE_CHECK_MS);
    expect(reports()[0]?.optimizer).toEqual([{ env: "ssr", kind: "scan", at: 1000, ms: 250 }]);
  });

  it("reports at the deadline when no page is requested", async () => {
    const { profiler, scheduled, runScheduled, reports } = setup();
    const [reporter] = await profiler.instrument([]);
    startServer(reporter!).httpServer.emit("listening");
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([DEADLINE_MS]);
    runScheduled(DEADLINE_MS);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.firstPage).toBeUndefined();
  });

  it("reports once, and stops timing per-module hooks after it", async () => {
    const { profiler, advance, runScheduled, reports } = setup();
    const plugin: Plugin = {
      name: "resolver",
      resolveId: () => {
        advance(10);
        return null;
      },
    };
    const [reporter] = await profiler.instrument([plugin]);
    const { httpServer, request } = startServer(reporter!);
    httpServer.emit("listening");
    (plugin.resolveId as () => void)();
    request("/").finish();
    runScheduled();
    (plugin.resolveId as () => void)();
    expect(request("/").next).toHaveBeenCalledOnce();
    runScheduled();
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.modules).toEqual([["resolver", "resolveId", 1, 10]]);
  });

  it("numbers each config load in the process, so a restart reports as a later start", async () => {
    const starts: number[] = [];
    for (const _ of [1, 2]) {
      const { profiler, runScheduled, reports } = setup();
      // oxlint-disable-next-line no-await-in-loop
      const [reporter] = await profiler.instrument([]);
      startServer(reporter!).httpServer.emit("listening");
      runScheduled(DEADLINE_MS);
      starts.push(reports()[0]!.start);
    }
    expect(starts[1]).toBe(starts[0]! + 1);
  });
});
