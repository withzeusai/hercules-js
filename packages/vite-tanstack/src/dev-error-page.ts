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

type Method = (...args: unknown[]) => unknown;

// Any of these while a response is held ends the hold: it goes out unchanged.
const HEADER_CALLS = "appendHeader flushHeaders removeHeader setHeader setHeaders writeEarlyHints";
const OTHER_CALLS = `${HEADER_CALLS} addTrailers cork uncork writeContinue`.split(" ");

/**
 * Lets `replace` swap a small 5xx JSON body for HTML when the response is
 * written exactly as the Cloudflare plugin writes it: `writeHead(status,
 * headers)`, then `write(chunk)` for each chunk, then `end()`. Any other call
 * sends what was held, unchanged, and stops intercepting. `onHead` runs when
 * the headers are written, and `replace` runs once after, without a body when
 * the response cannot be swapped.
 */
function replaceJsonError(
  response: ServerResponse,
  onHead: () => void,
  replace: (status: number, body?: string) => string | undefined,
): void {
  const res = response as unknown as Record<string, Method>;
  const writeHead = res.writeHead!;

  res.writeHead = (...head) => {
    res.writeHead = writeHead;
    onHead();
    const [status, headers] = head as [number, unknown];
    const isObject = typeof headers === "object" && headers !== null && !Array.isArray(headers);
    const entries = isObject ? Object.entries(headers) : [];
    const type = entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
    if (head.length !== 2 || status < 500 || !String(type).includes("application/json")) {
      replace(status);
      return writeHead.apply(res, head);
    }

    const originals = ["write", "end", ...OTHER_CALLS].map((name) => [name, res[name]!] as const);
    const restore = () => {
      for (const [name, method] of originals) res[name] = method;
    };
    const chunks: Uint8Array[] = [];
    let size = 0;
    const release = () => {
      restore();
      writeHead.apply(res, head);
      for (const chunk of chunks) res.write!(chunk);
    };
    const passThrough =
      (name: string): Method =>
      (...args) => {
        replace(status);
        release();
        return res[name]!(...args);
      };
    for (const name of OTHER_CALLS) res[name] = passThrough(name);
    res.write = (...args) => {
      const [chunk] = args;
      const fits = chunk instanceof Uint8Array && size + chunk.byteLength <= MAX_BODY_BYTES;
      if (args.length !== 1 || !fits) return passThrough("write")(...args);
      chunks.push(chunk);
      size += chunk.byteLength;
      return true;
    };
    res.end = (...args) => {
      if (args.length !== 0) return passThrough("end")(...args);
      const html = replace(status, Buffer.concat(chunks).toString());
      if (html === undefined) {
        release();
        return res.end!();
      }
      restore();
      // The app's policy may block the page's inline script.
      const replaced = /^(cache-control|content-(length|type|security-policy(-report-only)?))$/i;
      const kept = entries.filter(([name]) => !replaced.test(name));
      writeHead.call(res, status, {
        ...Object.fromEntries(kept),
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
      });
      return res.end!(html);
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
      // error just before it writes the headers, so the last one by then is
      // the request's. One logged while several run could be any of theirs.
      const { logger } = server.config;
      const logError = logger.error;
      const captureError: typeof logError = function (this: unknown, message, options) {
        const error = inFlight.size === 1 ? message : undefined;
        for (const request of inFlight) request.error = error;
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
        const stopCapture = () => inFlight.delete(request);
        replaceJsonError(res, stopCapture, (status, body) => {
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
