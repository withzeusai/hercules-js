import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { devErrorPage } from "./dev-error-page";

const START_ERROR = '{"status":500,"statusText":"","unhandled":true,"message":"HTTPError"}';
const LOGGED = "Error: Boom <b>&</b>\n    at handler (/app/src/start.ts:3:9)";
const DOCUMENT = { "sec-fetch-dest": "document", accept: "text/html" };

type Reply = {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string[];
  log?: string;
  /** Write each chunk only once the one before it is flushed, as streams do. */
  awaitWrites?: boolean;
};

const startError = (): Reply => ({
  status: 500,
  headers: { "content-type": "application/json", "content-length": START_ERROR.length },
  body: [START_ERROR],
  log: LOGGED,
});

let root: string | undefined;
let vite: ViteDevServer | undefined;
let http: Server | undefined;

afterEach(async () => {
  vi.useRealTimers();
  http?.close();
  await vite?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * A Vite dev server with the plugin, in front of a stand-in for the Worker
 * that logs `reply.log` and writes `reply` the way the Cloudflare plugin does.
 */
async function start(settleMs = 0) {
  let reply: Reply = { status: 200, headers: { "content-type": "text/html" }, body: ["<p>ok</p>"] };
  root = mkdtempSync(path.join(tmpdir(), "dev-error-page-"));
  vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, watch: null },
    plugins: [
      devErrorPage({ settleMs }),
      {
        name: "worker",
        configureServer(server) {
          server.middlewares.use((_req, res: ServerResponse) => {
            if (reply.log) server.config.logger.error(reply.log);
            res.writeHead(reply.status, reply.headers);
            const chunks = reply.body.map((chunk) => new TextEncoder().encode(chunk));
            if (!reply.awaitWrites) {
              for (const chunk of chunks) res.write(chunk);
              res.end();
              return;
            }
            const writeNext = () => {
              const chunk = chunks.shift();
              if (chunk) res.write(chunk, writeNext);
              else res.end();
            };
            writeNext();
          });
        },
      },
    ],
  });
  http = createHttpServer(vite.middlewares);
  await new Promise<void>((resolve) => http!.listen(0, resolve));
  const { port } = http.address() as AddressInfo;

  const get = (headers: Record<string, string> = DOCUMENT, method = "GET") =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = request({ port, path: "/page", method, headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
      },
    );
  return { vite, get, respond: (next: Reply) => (reply = next) };
}

describe("devErrorPage", () => {
  it("answers a page that keeps failing with Start's error with an error page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { get, respond } = await start(4000);
    respond(startError());

    // A failure that may still clear up keeps Start's JSON.
    expect(await get()).toMatchObject({ status: 500, body: START_ERROR });
    vi.advanceTimersByTime(3999);
    expect((await get()).body).toBe(START_ERROR);

    vi.advanceTimersByTime(1);
    const page = await get();
    expect(page.status).toBe(500);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-length"]).toBe(String(Buffer.byteLength(page.body)));
    expect(page.body).toContain("</head>");
    expect(page.body).toContain("Error: Boom &#60;b&#62;&#38;&#60;/b&#62;");
    expect(page.body).toContain(
      'console.error("[Vite Server Error]", {"message":"Error: Boom \\u003cb>&\\u003c/b>","stack":"    at handler (/app/src/start.ts:3:9)"});',
    );
    expect(page.body).toContain('import { createHotContext } from "/@vite/client";');
    expect(page.body).not.toContain("<b>");
  });

  it("passes every other response through byte for byte", async () => {
    const { get, respond } = await start();
    const html500: Reply = {
      status: 500,
      headers: { "content-type": "text/html" },
      body: ["<p>x</p>"],
    };
    const ownJson: Reply = {
      ...startError(),
      headers: { "content-type": "application/json" },
      body: ['{"status":500,"statusText":"","unhandled":true,"message":"HTTPError","detail":1}'],
    };
    const large: Reply = {
      ...startError(),
      headers: { "content-type": "application/json" },
      body: ["x".repeat(1000), "x".repeat(100)],
    };
    for (const reply of [html500, ownJson, large, { ...ownJson, awaitWrites: true }]) {
      respond(reply);
      expect(await get()).toMatchObject({ status: 500, body: reply.body.join("") });
    }

    // Fetches, such as server functions, and other methods keep Start's JSON.
    respond(startError());
    const fetches: Array<Record<string, string>> = [
      { "sec-fetch-dest": "empty", accept: "text/html" },
      { accept: "application/json" },
    ];
    for (const headers of fetches) expect((await get(headers)).body).toBe(START_ERROR);
    expect((await get(DOCUMENT, "POST")).body).toBe(START_ERROR);
  });

  it("treats a request that accepts HTML as a page load when the browser sends no Sec-Fetch-Dest", async () => {
    const { get, respond } = await start();
    respond(startError());
    expect((await get({ accept: "text/html" })).body).toContain("[Vite Server Error]");
  });

  it("answers a writer that waits for each write to flush", async () => {
    const { get, respond } = await start();
    respond({
      ...startError(),
      body: [START_ERROR.slice(0, 20), START_ERROR.slice(20)],
      awaitWrites: true,
    });
    expect((await get()).body).toContain("[Vite Server Error]");
  });

  it("shows only an error logged while the page load ran", async () => {
    const { vite, get, respond } = await start();
    vite.config.logger.error("Error: from an earlier request");
    respond({ ...startError(), log: undefined });
    const page = await get();
    expect(page.body).not.toContain("earlier request");
    expect(page.body).toContain("The cause is in the dev server log.");
  });

  it("starts over after the Worker reloads or the page loads, and reloads error pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { vite, get, respond } = await start(4000);
    const notify = vi.spyOn(vite.environments.client.hot, "send");
    respond(startError());
    await get();
    vi.advanceTimersByTime(4000);
    expect((await get()).body).toContain("[Vite Server Error]");

    vite.environments.ssr!.hot.send({ type: "full-reload" });
    expect(notify).toHaveBeenCalledExactlyOnceWith("hercules:server-reload");
    expect((await get()).body).toBe(START_ERROR);

    vi.advanceTimersByTime(4000);
    respond({ status: 200, headers: { "content-type": "text/html" }, body: ["<p>ok</p>"] });
    expect((await get()).body).toBe("<p>ok</p>");
    respond(startError());
    expect((await get()).body).toBe(START_ERROR);
  });
});
