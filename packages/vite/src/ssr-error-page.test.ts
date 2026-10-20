import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ERROR_PROBE_HEADER,
  createSsrErrorPageMiddleware,
  renderSsrErrorPage,
  ssrErrorPagePlugin,
} from "./ssr-error-page";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Reply {
  status: number;
  statusMessage: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The body TanStack Start sends when rendering throws something that is not a `Response`. */
const UNHANDLED_ERROR = JSON.stringify({
  status: 500,
  statusText: "",
  unhandled: true,
  message: "HTTPError",
});

/** Headers a browser sends when it loads a page in the preview iframe. */
const IFRAME_NAVIGATION = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-dest": "iframe",
  "sec-fetch-mode": "navigate",
};

let server: Server | undefined;
let vite: ViteDevServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await vite?.close();
  server = undefined;
  vite = undefined;
});

/** Serves `handler` behind the middleware, the way Vite runs it ahead of the SSR middleware. */
async function serve(handler: Handler, base = "/"): Promise<number> {
  const middleware = createSsrErrorPageMiddleware(base);
  const httpServer = createServer((req, res) => {
    middleware(req, res, () => {
      void handler(req, res);
    });
  });
  server = httpServer;
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return (httpServer.address() as AddressInfo).port;
}

function send(
  port: number,
  path: string,
  headers: OutgoingHttpHeaders,
  method = "GET",
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, resolve);
    req.on("error", reject);
    req.end();
  });
}

async function readReply(res: IncomingMessage): Promise<Reply> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return {
    status: res.statusCode ?? 0,
    statusMessage: res.statusMessage,
    headers: res.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

async function fetchReply(
  port: number,
  path: string,
  headers: OutgoingHttpHeaders = IFRAME_NAVIGATION,
  method = "GET",
): Promise<Reply> {
  return readReply(await send(port, path, headers, method));
}

/** Writes a response the way `@cloudflare/vite-plugin` copies a Worker `Response` onto Node's. */
function writeLikeCloudflare(
  status: number,
  headers: Record<string, string | string[]>,
  body: string,
): Handler {
  return async (_req, res) => {
    res.writeHead(status, headers);
    for (const chunk of [body.slice(0, 10), body.slice(10)]) {
      res.write(new TextEncoder().encode(chunk));
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  };
}

function expectErrorPage(reply: Reply): void {
  expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength(reply.body)));
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(reply.body).toMatch(/^<!doctype html>/);
  expect(reply.body).toContain("</head>");
  expect(reply.body).toContain("This page hit an error");
  expect(reply.body).not.toContain("HTTPError");
}

describe("SSR error page middleware", () => {
  it("replaces TanStack Start's JSON 500 with the error page", async () => {
    const port = await serve(
      writeLikeCloudflare(
        500,
        {
          "content-type": "application/json",
          "content-length": String(UNHANDLED_ERROR.length),
          "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
        },
        UNHANDLED_ERROR,
      ),
    );

    const reply = await fetchReply(port, "/dashboard");

    expect(reply.status).toBe(500);
    expectErrorPage(reply);
    expect(reply.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("replaces the JSON 500 when it is written with implicit headers", async () => {
    const port = await serve((_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Request-Id", "abc");
      res.end(UNHANDLED_ERROR);
    });

    const reply = await fetchReply(port, "/");

    expect(reply.status).toBe(503);
    expectErrorPage(reply);
    expect(reply.headers["x-request-id"]).toBe("abc");
  });

  it("replaces the JSON 500 written with a status message, a flat header array, and string chunks", async () => {
    const port = await serve((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.writeHead(500, "Render Failed", ["Content-Type", "application/json", "X-Trace", "t1"]);
      res.write(UNHANDLED_ERROR.slice(0, 5), "utf8");
      res.end(UNHANDLED_ERROR.slice(5));
    });

    const reply = await fetchReply(port, "/orders?page=2");

    expect(reply.status).toBe(500);
    expect(reply.statusMessage).toBe("Render Failed");
    expectErrorPage(reply);
    expect(reply.headers["x-trace"]).toBe("t1");
  });

  it("replaces the JSON 500 for an iframe load that does not accept text/html", async () => {
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json" }, UNHANDLED_ERROR),
    );

    const reply = await fetchReply(port, "/", { accept: "*/*", "sec-fetch-dest": "iframe" });

    expectErrorPage(reply);
  });

  it("calls write callbacks while it holds the body", async () => {
    const port = await serve(async (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      await new Promise((resolve) => res.write(UNHANDLED_ERROR, resolve));
      res.end();
    });

    expectErrorPage(await fetchReply(port, "/"));
  });

  it("leaves the app's own HTML 500 untouched", async () => {
    const html = "<!doctype html><html><head></head><body>Something went wrong</body></html>";
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "text/html; charset=utf-8" }, html),
    );

    const reply = await fetchReply(port, "/");

    expect(reply.status).toBe(500);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.body).toBe(html);
  });

  it("leaves a JSON 500 without `unhandled: true` untouched", async () => {
    const body = JSON.stringify({ error: "database unavailable" });
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json", "x-kept": "yes" }, body),
    );

    const reply = await fetchReply(port, "/");

    expect(reply.status).toBe(500);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.headers["x-kept"]).toBe("yes");
    expect(reply.body).toBe(body);
  });

  it("passes a large JSON 500 through unchanged", async () => {
    const body = JSON.stringify({ unhandled: true, detail: "x".repeat(100_000) });
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json" }, body),
    );

    const reply = await fetchReply(port, "/");

    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.body).toBe(body);
  });

  it("streams a 200 page without buffering it", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const port = await serve(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head>");
      await finished;
      res.end("</head><body>ok</body></html>");
    });

    const res = await send(port, "/", IFRAME_NAVIGATION);
    // The first chunk arrives while the handler is still waiting to finish.
    const first = await new Promise<string>((resolve) =>
      res.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
    );
    expect(res.statusCode).toBe(200);
    expect(first).toBe("<!doctype html><html><head>");

    finish();
    const rest = await readReply(res);
    expect(rest.body).toBe("</head><body>ok</body></html>");
  });

  it("leaves non-5xx JSON untouched", async () => {
    const body = JSON.stringify({ unhandled: true });
    const port = await serve(
      writeLikeCloudflare(404, { "content-type": "application/json" }, body),
    );

    const reply = await fetchReply(port, "/");

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(body);
  });

  it.each([
    ["a fetch", "/", { accept: "*/*", "sec-fetch-dest": "empty" }, "GET"],
    ["a server function call", "/", { ...IFRAME_NAVIGATION, "x-tsr-serverFn": "true" }, "GET"],
    ["a server function URL", "/_serverFn/abc123", IFRAME_NAVIGATION, "GET"],
    ["a Vite client request", "/@vite/client", IFRAME_NAVIGATION, "GET"],
    ["a Vite file system request", "/@fs/app/src/main.tsx", IFRAME_NAVIGATION, "GET"],
    ["a Vite internal route", "/__vite_ping", IFRAME_NAVIGATION, "GET"],
    ["a static asset", "/assets/logo.svg", IFRAME_NAVIGATION, "GET"],
    ["a form post", "/", IFRAME_NAVIGATION, "POST"],
    [
      "an error page probe",
      "/dashboard",
      { ...IFRAME_NAVIGATION, [ERROR_PROBE_HEADER]: "1" },
      "GET",
    ],
  ] as const)("leaves %s untouched", async (_name, path, headers, method) => {
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json" }, UNHANDLED_ERROR),
    );

    const reply = await fetchReply(port, path, headers, method);

    expect(reply.status).toBe(500);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.body).toBe(UNHANDLED_ERROR);
  });

  it("replaces the JSON 500 on an app route that starts with @", async () => {
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json" }, UNHANDLED_ERROR),
    );

    expectErrorPage(await fetchReply(port, "/@grant"));
  });

  it("strips the Vite base before it looks for Vite internals", async () => {
    const port = await serve(
      writeLikeCloudflare(500, { "content-type": "application/json" }, UNHANDLED_ERROR),
      "/app/",
    );

    expect((await fetchReply(port, "/app/@vite/client")).body).toBe(UNHANDLED_ERROR);
    expectErrorPage(await fetchReply(port, "/app/orders"));
  });
});

describe("SSR error page", () => {
  it("loads the Vite client from the configured base", () => {
    expect(renderSsrErrorPage("/")).toContain(
      '<script type="module" src="/@vite/client"></script>',
    );
    expect(renderSsrErrorPage("/app/")).toContain(
      '<script type="module" src="/app/@vite/client"></script>',
    );
  });

  it("polls its own URL with backoff and reloads once it renders", async () => {
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(renderSsrErrorPage("/"))?.[1];
    const replies: Array<number | Error> = [500, new Error("offline"), 500, 500, 502, 500, 200];
    const delays: number[] = [];
    const timers: Array<() => void> = [];
    const probes: string[] = [];
    let reloaded = false;

    runInNewContext(script ?? "", {
      location: {
        href: "http://localhost:5173/orders",
        reload: () => {
          reloaded = true;
        },
      },
      setTimeout: (callback: () => void, ms: number) => {
        delays.push(ms);
        timers.push(callback);
      },
      fetch: async (url: string, init: unknown) => {
        probes.push(JSON.stringify([url, init]));
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return { status: reply, body: null };
      },
    });

    while (!reloaded && timers.length > 0) {
      timers.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(reloaded).toBe(true);
    expect(delays).toEqual([1000, 1500, 2250, 3375, 5000, 5000, 5000]);
    expect(probes).toHaveLength(7);
    expect(JSON.parse(probes[0]!)).toEqual([
      "http://localhost:5173/orders",
      {
        cache: "no-store",
        redirect: "manual",
        headers: { accept: "text/html", [ERROR_PROBE_HEADER]: "1" },
      },
    ]);
  });
});

describe("ssrErrorPagePlugin", () => {
  it("serves the error page through the Vite dev server", async () => {
    // Stands in for the Cloudflare plugin, which answers pages after Vite's own middlewares.
    const fakeSsr: Plugin = {
      name: "fake-ssr",
      configureServer(devServer) {
        return () => {
          devServer.middlewares.use(
            writeLikeCloudflare(500, { "content-type": "application/json" }, UNHANDLED_ERROR),
          );
        };
      },
    };
    vite = await createViteServer({
      configFile: false,
      root: import.meta.dirname,
      base: "/app/",
      appType: "custom",
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1", watch: null, ws: false },
      plugins: [fakeSsr, ssrErrorPagePlugin()],
    });
    await vite.listen();
    const port = (vite.httpServer?.address() as AddressInfo).port;

    const page = await fetchReply(port, "/app/orders");
    expect(page.status).toBe(500);
    expectErrorPage(page);
    expect(page.body).toContain('src="/app/@vite/client"');

    const json = await fetchReply(port, "/app/orders", { accept: "application/json" });
    expect(json.body).toBe(UNHANDLED_ERROR);
  });
});
