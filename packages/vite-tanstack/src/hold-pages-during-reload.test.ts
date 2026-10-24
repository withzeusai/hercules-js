import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { holdPagesDuringReload } from "./hold-pages-during-reload";

type Middleware = (req: object, res: EventEmitter, next: () => void) => void;

function start() {
  let middleware: Middleware | undefined;
  const watcher = new EventEmitter();
  const hot = { send: vi.fn() };
  const server = {
    watcher,
    environments: { ssr: { hot } },
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
  return { server, watcher, page };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("holdPagesDuringReload", () => {
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
});
