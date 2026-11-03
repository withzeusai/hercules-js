import type { ServerResponse } from "node:http";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Plugin } from "vite";
import { reloadsProgram } from "./hold-pages-during-reload";

// Start's body is about 70 bytes; anything larger is the app's own response.
const MAX_BODY_BYTES = 1024;
const SERVER_RELOAD_EVENT = "hercules:server-reload";

/** Whether `body` is exactly what Start writes for an unhandled error. */
function isStartError(body: string, status: number): boolean {
  try {
    const { statusText } = JSON.parse(body);
    const expected = { status, statusText, unhandled: true, message: "HTTPError" };
    return typeof statusText === "string" && body === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function errorPage(logged: string | undefined, clientUrl: string): string {
  const text = logged
    ? stripVTControlCharacters(logged)
    : "The server failed to render this page. The cause is in the dev server log.";
  const at = text.search(/\n\s+at /);
  const error =
    at === -1 ? { message: text } : { message: text.slice(0, at), stack: text.slice(at + 1) };
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  // After `</head>`, where the preview injects its bridge, so the bridge sees the log.
  return `<!doctype html>
<head></head>
<body>
<pre>${escaped}</pre>
<script type="module">
import { createHotContext } from ${json(clientUrl)};
createHotContext("/@hercules/dev-error-page").on(${json(SERVER_RELOAD_EVENT)}, () => location.reload());
console.error("[Vite Server Error]", ${json(error)});
</script>
</body>
`;
}

type Chunk = string | Uint8Array;
type Writers = {
  writeHead(status: number, ...rest: unknown[]): unknown;
  write(chunk: Chunk, ...rest: unknown[]): boolean;
  end(...args: unknown[]): unknown;
};

/**
 * Lets `replace` swap a small 5xx JSON body written with
 * `writeHead(status, headers)`, as the Cloudflare plugin writes it, for HTML.
 * `replace` runs once, without a body when the response cannot be swapped.
 * Responses it leaves alone go out byte for byte.
 */
function replaceJsonError(
  response: ServerResponse,
  replace: (status: number, body?: string) => string | undefined,
): void {
  const res = response as unknown as Writers;
  const { writeHead, write, end } = res;

  res.writeHead = (status, ...rest) => {
    res.writeHead = writeHead;
    const headers = rest.find((arg) => typeof arg === "object" && arg !== null);
    const entries = headers && !Array.isArray(headers) ? Object.entries(headers) : [];
    const type = entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
    if (status < 500 || !String(type).includes("application/json")) {
      replace(status);
      return writeHead.call(res, status, ...rest);
    }

    const held: Array<[Chunk, unknown]> = [];
    let size = 0;
    const release = () => {
      Object.assign(res, { write, end });
      writeHead.call(res, status, ...rest);
      let ok = true;
      for (const [chunk, encoding] of held) ok = write.call(res, chunk, encoding);
      return ok;
    };
    res.write = (chunk, ...args) => {
      held.push([chunk, args.find((arg) => typeof arg === "string")]);
      // A writer may wait for the callback before it ends the response.
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) process.nextTick(callback as () => void);
      size += Buffer.byteLength(chunk);
      if (size <= MAX_BODY_BYTES) return true;
      replace(status);
      return release();
    };
    res.end = (...args) => {
      const chunks = held.map(([chunk]) => chunk);
      if (typeof args[0] === "string" || args[0] instanceof Uint8Array) chunks.push(args[0]);
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const html = replace(status, body.byteLength <= MAX_BODY_BYTES ? body.toString() : undefined);
      if (html === undefined) {
        release();
        return end.apply(res, args);
      }
      Object.assign(res, { write, end });
      // The app's policy may block the page's inline script.
      const replaced = /^(cache-control|content-(length|type|security-policy(-report-only)?))$/i;
      const kept = entries.filter(([name]) => !replaced.test(name));
      writeHead.call(res, status, {
        ...Object.fromEntries(kept),
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
      });
      const callback = args.find((arg) => typeof arg === "function");
      return end.call(res, html, callback);
    };
    return res;
  };
}

/**
 * Answers a page load that keeps failing with TanStack Start's bare JSON
 * error (thrown outside the router) with an HTML page, so the Hercules
 * preview can inject its bridge, see the error the Worker logged, and reload.
 * The JSON passes through for the first `settleMs`: the preview retries a
 * failing page load for 8 s (0.25 to 7.25 s), which hides failures that clear up.
 */
export function devErrorPage({ settleMs = 4000 }: { settleMs?: number } = {}): Plugin {
  return {
    name: "hercules:dev-error-page",
    apply: "serve",
    configureServer(server) {
      const failingSince = new Map<string, number>();
      const inFlight = new Set<{ error?: string }>();

      // The Cloudflare plugin passes the Worker's logs here. Start logs the
      // error just before it answers, so the last one is the request's.
      const { logger } = server.config;
      const logError = logger.error;
      const captureError: typeof logError = function (this: unknown, message, options) {
        for (const request of inFlight) request.error = message;
        return logError.call(this, message, options);
      };
      logger.error = captureError;
      server.httpServer?.once("close", () => {
        if (logger.error === captureError) logger.error = logError;
      });

      const hot = server.environments.ssr?.hot;
      if (hot) {
        const send = hot.send.bind(hot);
        hot.send = ((...args: Parameters<typeof send>) => {
          if (reloadsProgram(args[0])) {
            failingSince.clear();
            server.environments.client.hot.send(SERVER_RELOAD_EVENT);
          }
          return send(...args);
        }) as typeof hot.send;
      }
      const clientUrl = path.posix.join(server.config.base, "@vite/client");

      server.middlewares.use((req, res, next) => {
        const dest = req.headers["sec-fetch-dest"];
        const isPage =
          dest === undefined
            ? req.headers.accept?.includes("text/html")
            : dest === "document" || dest === "iframe";
        if (req.method !== "GET" || !isPage) return next();
        const url = req.url ?? "/";
        const request: { error?: string } = {};
        inFlight.add(request);
        res.once("close", () => inFlight.delete(request));
        replaceJsonError(res, (status, body) => {
          inFlight.delete(request);
          if (body === undefined || !isStartError(body, status)) {
            failingSince.delete(url);
            return undefined;
          }
          const since = failingSince.get(url) ?? Date.now();
          failingSince.set(url, since);
          return Date.now() - since < settleMs ? undefined : errorPage(request.error, clientUrl);
        });
        next();
      });
    },
  };
}
