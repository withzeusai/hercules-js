import { normalizePath, type Plugin, type ViteDevServer } from "vite";

/**
 * Whether a message on the Worker's hot channel reloads its program: a full
 * reload, or an update that re-runs changed modules. Custom events do not.
 */
function reloadsProgram(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("type" in payload)) {
    return false;
  }
  return payload.type === "full-reload" || payload.type === "update";
}

/**
 * Returns a check for whether the watcher has seen a write to a module the
 * Worker loaded but not reported it yet. With `awaitWriteFinish` (set on
 * Hercules dev machines), chokidar keeps a written file in its private
 * `_pendingWrites` until the file stops changing, and only then does Vite
 * reload the Worker. Without that option, or if chokidar drops the field,
 * nothing is pending.
 */
function pendingModuleWrite(server: ViteDevServer): () => boolean {
  const pending = (server.watcher as { _pendingWrites?: unknown })._pendingWrites;
  const graph = server.environments.ssr?.moduleGraph;
  if (!(pending instanceof Map) || !graph) return () => false;
  const files = pending as Map<string, unknown>;
  return () => [...files.keys()].some((file) => graph.getModulesByFile(normalizePath(file))?.size);
}

/**
 * Holds page requests while the server program reloads, then lets one through
 * ahead of the rest.
 *
 * A change that needs a full reload (a moved route file, a regenerated route
 * tree) makes Vite reload the browser and the Worker program together. The
 * Worker re-evaluates its modules on the next request, and requests that
 * arrive while that is under way see half-initialized modules: the render
 * fails once with errors such as "Invalid hook call" or "is not a function",
 * then the next request succeeds. So page requests wait until the reloads go
 * quiet, the first one warms the program alone, and the others follow.
 * A request already rendering when the reload starts can still fail.
 *
 * A hold starts on a reload sent to the Worker, or on a page request while a
 * write to a module the Worker loaded waits out `awaitWriteFinish`: rendering
 * then would serve the old module to a browser that loads the new one, and
 * React reports a hydration mismatch. Other file events do not hold pages:
 * miniflare writes its request trace store under `.wrangler` on every request,
 * so they would hold every page that follows another within the quiet period.
 */
export function holdPagesDuringReload(): Plugin {
  const QUIET_MS = 500;
  // Below the 5 s navigation timeout of the screenshot browser.
  const MAX_HOLD_MS = 3000;
  // How often a held request re-checks for a pending write. Well under
  // QUIET_MS, so the reload a finished write sends is seen before release.
  const POLL_MS = 100;
  let lastChangeAt = 0;
  let warm = true;
  let warming = false;
  const waiting: Array<() => void> = [];

  return {
    name: "hercules:hold-pages-during-reload",
    apply: "serve",
    configureServer(server) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const writePending = pendingModuleWrite(server);

      const releaseAll = () => {
        warm = true;
        warming = false;
        for (const proceed of waiting.splice(0)) proceed();
      };

      const pump = () => {
        timer = undefined;
        if (warm || warming || waiting.length === 0) return;
        if (writePending()) touch();
        const quietFor = Date.now() - lastChangeAt;
        if (quietFor < QUIET_MS) {
          timer = setTimeout(pump, Math.min(QUIET_MS - quietFor, POLL_MS));
          return;
        }
        // The first request re-evaluates the program by itself.
        warming = true;
        waiting.shift()?.();
      };

      const touch = () => {
        lastChangeAt = Date.now();
        warm = false;
      };
      const hot = server.environments.ssr?.hot;
      if (hot) {
        const send = hot.send.bind(hot);
        hot.send = ((...args: Parameters<typeof send>) => {
          if (reloadsProgram(args[0])) touch();
          return send(...args);
        }) as typeof hot.send;
      }

      server.middlewares.use((req, res, next) => {
        const isPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
        if (!isPage) return next();
        if (writePending()) touch();
        if (warm) return next();

        let released = false;
        const proceed = () => {
          if (released) return;
          released = true;
          clearTimeout(giveUp);
          if (warming && !warm) {
            // This is the warming request: the rest follow once it is done,
            // unless the files changed again while it ran.
            const startedAt = Date.now();
            const done = () => {
              if (lastChangeAt > startedAt) {
                warming = false;
                pump();
              } else {
                releaseAll();
              }
            };
            res.once("finish", done);
            res.once("close", done);
          }
          next();
        };
        // Never hold a request for long: a stuck warm-up must not hang the app.
        const giveUp = setTimeout(() => {
          const index = waiting.indexOf(proceed);
          if (index !== -1) waiting.splice(index, 1);
          released = true;
          next();
        }, MAX_HOLD_MS);
        waiting.push(proceed);
        if (timer === undefined) pump();
      });
    },
  };
}
