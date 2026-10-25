import { existsSync } from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { readManifest } from "./dependencies";

const LOCKFILES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

function isManifestOrLockfile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "package.json" || LOCKFILES.includes(relative);
}

const RESTART_DEBOUNCE_MS = 1000;
// pnpm can write package.json before the new package is linked. Keep checking
// for a while so a package that lands late is still picked up.
const INSTALL_POLL_MS = 1000;
const INSTALL_POLL_LIMIT = 60;

function isInstalled(root: string, name: string): boolean {
  return existsSync(path.join(root, "node_modules", name, "package.json"));
}

interface HotSender {
  send(...args: unknown[]): void;
}

/**
 * Restarts the dev server with its HMR messages muted. Until the new server
 * listens, a message from the old one (a reload for a route file the agent
 * wrote meanwhile) sends the browser to a port that is about to close, and
 * the page stays on a connection error. Browsers reload by themselves once
 * the new server accepts their socket. A failed restart keeps the old server,
 * so it gets its messages back.
 */
function restartQuietly(server: ViteDevServer): Promise<void> {
  const { environments } = server;
  const channels: HotSender[] = [
    server.ws,
    ...Object.values(environments).map((environment) => environment.hot),
  ];
  const sends = channels.map((channel) => [channel, channel.send] as const);
  for (const [channel] of sends) channel.send = () => {};
  return server.restart().finally(() => {
    if (server.environments !== environments) return;
    for (const [channel, send] of sends) channel.send = send;
  });
}

export interface WatchDependenciesOptions {
  /** Vite root, where the app's `package.json` and `node_modules` live. */
  root: string;
  /** The dependencies the running server was configured to bundle. */
  started: readonly string[];
  /** The dependencies the server would bundle now, read from disk on each check. */
  current: () => string[];
}

/**
 * Restarts the dev server when `package.json` or the lockfile changes and the
 * dependencies it would bundle differ from `started`, the list the running
 * server was configured with.
 */
export function watchDependencies(
  server: ViteDevServer,
  { root, started, current }: WatchDependenciesOptions,
): void {
  const startedKey = started.join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polls = 0;
  let restarting = false;

  const check = () => {
    timer = undefined;
    if (restarting) return;
    if (current().join("\n") !== startedKey) {
      restarting = true;
      server.config.logger.info(
        "[hercules] dependencies changed; restarting the dev server to pre-bundle them",
        { timestamp: true },
      );
      void restartQuietly(server);
      return;
    }
    const declared = Object.keys(readManifest(path.join(root, "package.json"))?.dependencies ?? {});
    const pending = declared.some((name) => !isInstalled(root, name));
    if (pending && polls < INSTALL_POLL_LIMIT) {
      polls += 1;
      timer = setTimeout(check, INSTALL_POLL_MS);
    }
  };

  const schedule = (file: string) => {
    if (!isManifestOrLockfile(root, file)) return;
    polls = 0;
    clearTimeout(timer);
    timer = setTimeout(check, RESTART_DEBOUNCE_MS);
  };

  server.watcher.add([
    path.join(root, "package.json"),
    ...LOCKFILES.map((file) => path.join(root, file)),
  ]);
  server.watcher.on("add", schedule);
  server.watcher.on("change", schedule);
  server.httpServer?.once("close", () => clearTimeout(timer));
}
