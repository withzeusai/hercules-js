import type { IncomingMessage, OutgoingHttpHeader, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

/**
 * Header the error page sets on the requests it polls with. The middleware
 * leaves those responses alone, so the page sees the real status.
 */
export const ERROR_PROBE_HEADER = "x-hercules-error-probe";

/**
 * Largest 5xx JSON body held back for inspection. TanStack Start's fallback
 * body is under 100 bytes; anything past this limit is sent on unchanged.
 */
const MAX_BUFFERED_BYTES = 64 * 1024;

/** Headers that describe the original body and are dropped from the page. */
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "etag",
  "last-modified",
  "cache-control",
];

/** Requests Vite and its plugins answer themselves, never an SSR page. */
const VITE_INTERNAL = /^\/(?:@(?:vite|fs|id)\/|@react-refresh$|__)/;

/** Files Vite serves as assets or modules rather than as pages. */
const STATIC_ASSET =
  /\.(?:[cm]?js|[cm]?ts|jsx|tsx|css|map|json|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|wasm|txt|xml|pdf|zip)$/i;

/** TanStack Start's server function endpoint, `/_serverFn/` by default. */
const SERVER_FUNCTION = /\/_serverFn(?:\/|$)/;

type HeaderPair = [name: string, value: OutgoingHttpHeader];

/** `ServerResponse` methods without their overloads, so they can be forwarded as is. */
type ResponseMethod = (this: ServerResponse, ...args: unknown[]) => unknown;

/**
 * Replaces TanStack Start's raw JSON 500 on dev page loads with an HTML page
 * that reloads itself once the page renders again.
 *
 * When server rendering throws something that is not a `Response`, Start
 * answers with `{"status":500,"unhandled":true,"message":"HTTPError"}` as
 * `application/json`. In the preview iframe that shows up as raw JSON, and
 * since it has no `</head>`, the Hercules bridge script is never injected
 * either, so nothing recovers until someone reloads by hand.
 */
export function ssrErrorPagePlugin(): Plugin {
  return {
    name: "vite-plugin-hercules-ssr-error-page",
    apply: "serve",
    // Registers the middleware ahead of other plugins' middlewares, such as
    // the Cloudflare plugin's, so it sees every SSR response.
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(createSsrErrorPageMiddleware(server.config.base));
    },
  };
}

/**
 * Connect middleware behind {@link ssrErrorPagePlugin}. For page navigations
 * only, it watches the response and, if it turns out to be a 5xx JSON body
 * with `"unhandled":true`, sends the error page instead with the same status.
 * Every other response is passed through as it is written, without buffering.
 */
export function createSsrErrorPageMiddleware(base: string): Connect.NextHandleFunction {
  return function herculesSsrErrorPage(req, res, next) {
    if (isPageNavigation(req, base)) interceptUnhandledError(res, base);
    next();
  };
}

function isPageNavigation(req: IncomingMessage, base: string): boolean {
  if (req.method !== "GET") return false;
  if (req.headers[ERROR_PROBE_HEADER] !== undefined) return false;
  if (req.headers["x-tsr-serverfn"] !== undefined) return false;

  const accept = req.headers.accept ?? "";
  const dest = req.headers["sec-fetch-dest"];
  if (!accept.includes("text/html") && dest !== "document" && dest !== "iframe") return false;

  const pathname = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  const path =
    base !== "/" && pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname;
  return !(VITE_INTERNAL.test(path) || SERVER_FUNCTION.test(path) || STATIC_ASSET.test(path));
}

function isJsonServerError(
  statusCode: number,
  contentType: string | undefined,
  contentEncoding: string | undefined,
): boolean {
  if (statusCode < 500 || statusCode > 599) return false;
  const encoding = contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return false;
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || mime.endsWith("+json");
}

function isUnhandledErrorBody(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { unhandled?: unknown }).unhandled === true
    );
  } catch {
    return false;
  }
}

/** Normalizes the headers argument of `writeHead` (object, flat array, or tuples). */
function toHeaderPairs(headers: unknown): HeaderPair[] {
  if (!headers || typeof headers !== "object") return [];
  if (!Array.isArray(headers)) {
    return Object.entries(headers as Record<string, OutgoingHttpHeader | undefined>).filter(
      (entry): entry is HeaderPair => entry[1] !== undefined,
    );
  }
  if (Array.isArray(headers[0])) {
    return (headers as [string, OutgoingHttpHeader][]).map(([name, value]) => [
      String(name),
      value,
    ]);
  }
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < headers.length; i += 2) {
    pairs.push([String(headers[i]), headers[i + 1] as OutgoingHttpHeader]);
  }
  return pairs;
}

function readHeader(res: ServerResponse, pairs: HeaderPair[], name: string): string | undefined {
  // Headers passed to `writeHead` take precedence over `setHeader` ones.
  const pair = pairs.filter(([key]) => key.toLowerCase() === name).pop();
  const value = pair ? pair[1] : res.getHeader(name);
  if (value === undefined) return undefined;
  return String(Array.isArray(value) ? value[0] : value);
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk));
}

/**
 * Wraps the response's write methods. The decision is made once, when the
 * headers would go out (`writeHead`, the first `write`, `end`, or
 * `flushHeaders`). A response that is not a 5xx JSON from then on goes
 * straight to the original methods. A candidate is held until `end`, then
 * either replaced with the error page or replayed exactly as written.
 */
function interceptUnhandledError(res: ServerResponse, base: string): void {
  const originalWriteHead = res.writeHead as unknown as ResponseMethod;
  const originalWrite = res.write as unknown as ResponseMethod;
  const originalEnd = res.end as unknown as ResponseMethod;
  const originalFlushHeaders = res.flushHeaders as ResponseMethod | undefined;

  let state: "pending" | "buffering" | "passthrough" = "pending";
  let heldHead: unknown[] | undefined;
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;

  function decide(statusCode: number, headers: HeaderPair[]): void {
    const contentType = readHeader(res, headers, "content-type");
    const contentEncoding = readHeader(res, headers, "content-encoding");
    state = isJsonServerError(statusCode, contentType, contentEncoding)
      ? "buffering"
      : "passthrough";
  }

  /** Sends what was held back as it was written, then stops intercepting. */
  function releaseHeld(): void {
    state = "passthrough";
    if (heldHead) originalWriteHead.apply(res, heldHead);
    if (bufferedBytes > 0) originalWrite.call(res, Buffer.concat(chunks));
    chunks.length = 0;
  }

  function hold(chunk: unknown, encoding: unknown): void {
    const buffer = toBuffer(chunk, encoding);
    chunks.push(buffer);
    bufferedBytes += buffer.length;
    if (bufferedBytes > MAX_BUFFERED_BYTES) releaseHeld();
  }

  function sendErrorPage(callback: (() => void) | undefined): void {
    state = "passthrough";
    const statusCode = heldHead ? (heldHead[0] as number) : res.statusCode;
    const statusMessage =
      heldHead && typeof heldHead[1] === "string" ? heldHead[1] : res.statusMessage;
    const headArgument = heldHead && typeof heldHead[1] === "string" ? heldHead[2] : heldHead?.[1];

    for (const name of BODY_HEADERS) res.removeHeader(name);
    const kept = new Map<string, { name: string; values: string[] }>();
    for (const [name, value] of toHeaderPairs(headArgument)) {
      const key = name.toLowerCase();
      if (BODY_HEADERS.includes(key)) continue;
      const entry = kept.get(key) ?? { name, values: [] };
      entry.values.push(...(Array.isArray(value) ? value : [String(value)]));
      kept.set(key, entry);
    }
    for (const { name, values } of kept.values()) {
      res.setHeader(name, values.length === 1 ? values[0]! : values);
    }

    const html = renderSsrErrorPage(base);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-length", Buffer.byteLength(html));
    res.setHeader("cache-control", "no-store");
    if (statusMessage) originalWriteHead.call(res, statusCode, statusMessage);
    else originalWriteHead.call(res, statusCode);
    if (callback) originalEnd.call(res, html, callback);
    else originalEnd.call(res, html);
  }

  res.writeHead = function writeHead(this: ServerResponse, ...args: unknown[]) {
    if (state === "pending") {
      const headers = typeof args[1] === "string" ? args[2] : args[1];
      decide(args[0] as number, toHeaderPairs(headers));
    }
    if (state !== "buffering") {
      return originalWriteHead.apply(this, args);
    }
    heldHead = args;
    return this;
  } as unknown as typeof res.writeHead;

  res.write = function write(this: ServerResponse, ...args: unknown[]) {
    if (state === "pending") decide(this.statusCode, []);
    if (state !== "buffering") {
      return originalWrite.apply(this, args);
    }
    hold(args[0], args[1]);
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    if (callback) process.nextTick(callback);
    return true;
  } as unknown as typeof res.write;

  res.end = function end(this: ServerResponse, ...args: unknown[]) {
    if (state === "pending") decide(this.statusCode, []);
    if (state !== "buffering") {
      return originalEnd.apply(this, args);
    }
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    const chunk = typeof args[0] === "function" ? undefined : args[0];
    if (chunk !== undefined && chunk !== null) hold(chunk, args[1]);

    if (state === "buffering" && isUnhandledErrorBody(Buffer.concat(chunks))) {
      sendErrorPage(callback);
      return this;
    }
    if (state === "buffering") releaseHeld();
    if (callback) originalEnd.call(this, callback);
    else originalEnd.call(this);
    return this;
  } as unknown as typeof res.end;

  if (typeof originalFlushHeaders === "function") {
    res.flushHeaders = function flushHeaders(this: ServerResponse) {
      if (state === "pending") decide(this.statusCode, []);
      // A held response sends its headers with the body.
      if (state !== "buffering") originalFlushHeaders.call(this);
    };
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Polls the page's own URL with backoff and reloads once it answers below
 * 500. Runs as a module so its names stay out of the global scope that the
 * injected bridge script shares.
 */
const RECOVERY_SCRIPT = `
const MAX_DELAY_MS = 5000;
let delay = 1000;

async function probe() {
  try {
    const response = await fetch(location.href, {
      cache: "no-store",
      redirect: "manual",
      headers: { accept: "text/html", "${ERROR_PROBE_HEADER}": "1" },
    });
    response.body?.cancel().catch(() => {});
    if (response.status < 500) {
      location.reload();
      return;
    }
  } catch {
    // The dev server is restarting or unreachable; try again.
  }
  delay = Math.min(delay * 1.5, MAX_DELAY_MS);
  setTimeout(probe, delay);
}

setTimeout(probe, delay);
`;

/**
 * The page sent in place of the JSON error. It has a `</head>` so the dev
 * proxy injects the Hercules bridge, loads the Vite client so the next file
 * change reloads it, and polls so it also recovers without one.
 */
export function renderSsrErrorPage(base: string): string {
  const viteClient = escapeAttribute(`${base.endsWith("/") ? base : `${base}/`}@vite/client`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>This page hit an error</title>
<style>
:root { --background: #ffffff; --foreground: #18181b; --muted: #71717a; }
@media (prefers-color-scheme: dark) {
  :root { --background: #09090b; --foreground: #fafafa; --muted: #a1a1aa; }
}
html, body { height: 100%; margin: 0; }
body {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--background);
  color: var(--foreground);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 28rem; text-align: center; }
h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
p { margin: 0; color: var(--muted); }
</style>
<script type="module" src="${viteClient}"></script>
<script type="module">${RECOVERY_SCRIPT}</script>
</head>
<body>
<main>
<h1>This page hit an error</h1>
<p>The app threw an error while rendering this page. It will reload on its own once the code is fixed.</p>
</main>
</body>
</html>
`;
}
