import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { dependenciesToPrebundle } from "./dependencies";
import { watchDependencies } from "./restart-on-install";
import { appRoot, declare, install, lib } from "./testing";

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

function start(root: string): FakeServer {
  const current = () => dependenciesToPrebundle(root, new Set());
  const fake = fakeServer();
  watchDependencies(fake.server, { root, started: current(), current });
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchDependencies", () => {
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
});
