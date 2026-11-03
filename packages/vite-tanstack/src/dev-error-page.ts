import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Plugin } from "vite";
import { reloadsProgram } from "./hold-pages-during-reload";

// Start's body is about 70 bytes; anything larger is the app's own response.
const MAX_BODY_BYTES = 1024;
/** Sent to error pages when the Worker reloads, so they try again. */
export const SERVER_RELOAD_EVENT = "hercules:server-reload";

function isPageLoad(req: IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (dest !== undefined) return dest === "document" || dest === "iframe";
  return req.headers.accept?.includes("text/html") ?? false;
}

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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function errorPage(logged: string | undefined, clientUrl: string): string {
  const text = logged
    ? stripVTControlCharacters(logged)
    : "The server failed to render this page. The cause is in the dev server log.";
  const at = text.search(/\n\s+at /);
  const error =
    at === -1 ? { message: text } : { message: text.slice(0, at), stack: text.slice(at + 1) };
  // Inside a script, `<` is escaped so the text cannot close the tag.
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Server error</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 2rem; font-family: system-ui, sans-serif; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <h1>This page failed to render</h1>
    <pre>${escapeHtml(text)}</pre>
    <script type="module">
      console.error("[Vite Server Error]", ${json(error)});
    </script>
    <script type="module">
      import { createHotContext } from ${json(clientUrl)};
      createHotContext("/@hercules/dev-error-page").on(${json(SERVER_RELOAD_EVENT)}, () => location.reload());
    </script>
  </body>
</html>
`;
}

/** A page load not answered yet, with the last error logged since it started. */
type PageLoad = { error?: string };

type Chunk = string | Uint8Array;
/** `ServerResponse`'s writers, without their overloads. */
type Writers = {
  writeHead(status: number, ...rest: unknown[]): unknown;
  write(chunk: Chunk, ...rest: unknown[]): boolean;
  end(...args: unknown[]): unknown;
};

// Set by the error page, or dropped: the app's policy may block its inline scripts.
const REPLACED_HEADER =
  /^(cache-control|content-length|content-type|content-security-policy(-report-only)?)$/i;

/**
 * Lets `replace` swap the body of a 5xx JSON response of at most
 * {@link MAX_BODY_BYTES} for an HTML page. `replace` runs once per response:
 * with the body when it could be swapped, or with none once it cannot. When
 * it returns nothing, the response goes out byte for byte as written; only
 * those small 5xx JSON bodies are held until they end. Handles responses
 * written with `writeHead(status, headers)`, as the Cloudflare plugin writes
 * them.
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

    const held: Array<[Chunk, ...unknown[]]> = [];
    let size = 0;
    const release = () => {
      Object.assign(res, { write, end });
      writeHead.call(res, status, ...rest);
      let ok = true;
      for (const args of held) ok = write.apply(res, args);
      return ok;
    };
    res.write = (...args) => {
      held.push(args);
      size += Buffer.byteLength(args[0]);
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
      writeHead.call(res, status, {
        ...Object.fromEntries(entries.filter(([name]) => !REPLACED_HEADER.test(name))),
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
 * error with an HTML page showing the error, on the dev server only.
 *
 * Start answers an error thrown outside the router (request middleware,
 * `getRouter`, a route tree that fails to import) with
 * `{"status":500,...,"unhandled":true,"message":"HTTPError"}` and logs the
 * error only in the Worker. A JSON page has no `</head>`, so the Hercules
 * preview cannot inject its bridge into it. The page instead shows the error
 * the Worker logged while the request ran, reports it to the preview as
 * `[Vite Server Error]`, and reloads when the Worker reloads.
 *
 * Most such failures clear up within moments, as a reload settles, and the
 * preview retries a failing page load for 8 s while it keeps showing the old
 * page. So the JSON passes through until the same page has kept failing for
 * `settleMs` since the Worker last reloaded. Every other response is
 * untouched.
 */
export function devErrorPage({ settleMs = 4000 }: { settleMs?: number } = {}): Plugin {
  return {
    name: "hercules:dev-error-page",
    apply: "serve",
    configureServer(server) {
      // When each page that keeps failing first failed.
      const failingSince = new Map<string, number>();
      // Start logs the error just before it answers.
      const inFlight = new Set<PageLoad>();

      // The Cloudflare plugin passes the Worker's logs to this logger.
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
            // Pages without an error page ignore the event.
            server.environments.client.hot.send(SERVER_RELOAD_EVENT);
          }
          return send(...args);
        }) as typeof hot.send;
      }
      const clientUrl = path.posix.join(server.config.base, "@vite/client");

      server.middlewares.use((req, res, next) => {
        if (!isPageLoad(req)) return next();
        const url = req.url ?? "/";
        const request: PageLoad = {};
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
          if (Date.now() - since < settleMs) return undefined;
          return errorPage(request.error, clientUrl);
        });
        next();
      });
    },
  };
}
