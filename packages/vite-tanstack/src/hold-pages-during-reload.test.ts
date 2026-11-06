import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import { holdPagesDuringReload } from "./hold-pages-during-reload";

type Middleware = (req: object, res: EventEmitter, next: () => void) => void;

const MODULE = "/app/src/components/ui/slider.tsx";

function start() {
  let middleware: Middleware | undefined;
  // What chokidar keeps while `awaitWriteFinish` waits for a write to settle.
  const pendingWrites = new Map<string, object>();
  const watcher = Object.assign(new EventEmitter(), { _pendingWrites: pendingWrites });
  const hot = { send: vi.fn() };
  const moduleGraph = {
    getModulesByFile: (file: string) => (file === MODULE ? new Set([{ file }]) : undefined),
  };
  const server = {
    watcher,
    environments: { ssr: { hot, moduleGraph } },
    middlewares: {
      use: (fn: Middleware) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer;
  const plugin = holdPagesDuringReload();
  (plugin.configureServer as (server: ViteDevServer) => void)(server);

  /** Sends a page request and returns its `next` spy and a way to finish it. */
  const page = () => {
    const next = vi.fn();
    const res = new EventEmitter();
    middleware!({ method: "GET", headers: { accept: "text/html" } }, res, next);
    return { next, finish: () => res.emit("finish") };
  };
  return { server, watcher, pendingWrites, page };
}

describe("holdPagesDuringReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets pages through when nothing reloaded", () => {
    const { page } = start();
    expect(page().next).toHaveBeenCalledOnce();
    expect(page().next).toHaveBeenCalledOnce();
  });

  it("ignores file events, such as the trace store miniflare writes on every request", () => {
    const { watcher, page } = start();
    watcher.emit("all", "change", "/app/.wrangler/state/v3/observability/trace.sqlite-wal");
    expect(page().next).toHaveBeenCalledOnce();
  });

  it("ignores custom events on the Worker's hot channel", () => {
    const { server, page } = start();
    server.environments.ssr!.hot.send({ type: "custom", event: "vite:invoke", data: {} });
    server.environments.ssr!.hot.send("my:event", {});
    expect(page().next).toHaveBeenCalledOnce();
  });

  it("holds pages after a reload until it goes quiet, warming with the first", () => {
    const { server, page } = start();
    server.environments.ssr!.hot.send({ type: "full-reload", path: "*" });

    const first = page();
    const second = page();
    vi.advanceTimersByTime(499);
    expect(first.next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.next).toHaveBeenCalledOnce();
    expect(second.next).not.toHaveBeenCalled();

    first.finish();
    expect(second.next).toHaveBeenCalledOnce();
    expect(page().next).toHaveBeenCalledOnce();
  });

  it("treats a module update as a reload", () => {
    const { server, page } = start();
    server.environments.ssr!.hot.send({ type: "update", updates: [] });
    const held = page();
    expect(held.next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(held.next).toHaveBeenCalledOnce();
  });

  it("holds pages while a write to a module the Worker loaded is pending", () => {
    const { server, pendingWrites, page } = start();
    pendingWrites.set(MODULE, {});
    const held = page();
    vi.advanceTimersByTime(1000);
    expect(held.next).not.toHaveBeenCalled();

    // The write settles and Vite reloads the Worker with it.
    pendingWrites.delete(MODULE);
    vi.advanceTimersByTime(50);
    server.environments.ssr!.hot.send({ type: "update", updates: [] });
    vi.advanceTimersByTime(499);
    expect(held.next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(held.next).toHaveBeenCalledOnce();
  });

  it("ignores pending writes to files the Worker did not load", () => {
    const { pendingWrites, page } = start();
    pendingWrites.set("/app/.scratch/notes.md", {});
    expect(page().next).toHaveBeenCalledOnce();
  });

  it("stops holding after 3 s even if the write never settles", () => {
    const { pendingWrites, page } = start();
    pendingWrites.set(MODULE, {});
    const held = page();
    vi.advanceTimersByTime(2999);
    expect(held.next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(held.next).toHaveBeenCalledOnce();
  });
});

describe("holdPagesDuringReload on a Vite dev server", () => {
  let root: string | undefined;
  let vite: ViteDevServer | undefined;
  afterEach(async () => {
    await vite?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("renders a page requested right after an edit with the edited module", async () => {
    root = mkdtempSync(path.join(tmpdir(), "hold-pages-"));
    const file = normalizePath(path.join(root, "page.ts"));
    writeFileSync(file, "export const line = 1;\n");
    vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [holdPagesDuringReload()],
      server: {
        middlewareMode: true,
        watch: { awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 } },
      },
    });
    const pendingWrites = (vite.watcher as unknown as { _pendingWrites: Map<string, object> })
      ._pendingWrites;
    const render = async () => ((await vite!.ssrLoadModule(file)) as { line: number }).line;
    expect(await render()).toBe(1);

    const http = createHttpServer(vite.middlewares);
    await new Promise<void>((resolve) => http.listen(0, resolve));
    try {
      const { port } = http.address() as AddressInfo;
      writeFileSync(file, "export const line = 2;\n");
      await vi.waitUntil(() => pendingWrites.has(file));

      // The page waits for the Worker to reload, so it renders the edit.
      await fetch(`http://localhost:${port}/`, { headers: { accept: "text/html" } });
      expect(await render()).toBe(2);
    } finally {
      http.close();
    }
  }, 10_000);
});
