import type { Plugin } from "vite";

/**
 * Holds page requests while the server program reloads, then lets one through
 * ahead of the rest.
 *
 * A change that needs a full reload (a moved route file, a regenerated route
 * tree) makes Vite reload the browser and the Worker program together. The
 * Worker re-evaluates its modules on the next request, and requests that
 * arrive while that is under way see half-initialized modules: the render
 * fails once with errors such as "Invalid hook call" or "is not a function",
 * then the next request succeeds. So page requests wait until the file changes
 * go quiet, the first one warms the program alone, and the others follow.
 * A request already rendering when the reload starts can still fail.
 */
export function holdPagesDuringReload(): Plugin {
  const QUIET_MS = 500;
  // Below the 5 s navigation timeout of the screenshot browser.
  const MAX_HOLD_MS = 3000;
  let lastChangeAt = 0;
  let warm = true;
  let warming = false;
  const waiting: Array<() => void> = [];

  return {
    name: "hercules:hold-pages-during-reload",
    apply: "serve",
    configureServer(server) {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const releaseAll = () => {
        warm = true;
        warming = false;
        for (const proceed of waiting.splice(0)) proceed();
      };

      const pump = () => {
        timer = undefined;
        if (warm || warming || waiting.length === 0) return;
        const quietFor = Date.now() - lastChangeAt;
        if (quietFor < QUIET_MS) {
          timer = setTimeout(pump, QUIET_MS - quietFor);
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
      server.watcher.on("all", touch);
      const hot = server.environments.ssr?.hot;
      if (hot) {
        const send = hot.send.bind(hot);
        hot.send = ((...args: Parameters<typeof send>) => {
          touch();
          return send(...args);
        }) as typeof hot.send;
      }

      server.middlewares.use((req, res, next) => {
        const isPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
        if (!isPage || warm) return next();

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
