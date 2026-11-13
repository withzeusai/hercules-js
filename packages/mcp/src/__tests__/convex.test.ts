import { ConvexError, v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineMcpServer,
  McpToolError,
  tool,
  validatorToJsonSchema,
  type McpToolCtx,
} from "../convex";
import { createTokenVerifier } from "../jwt";
import { createMcpHandler } from "../server";
import {
  AUDIENCE,
  createTestIssuer,
  ISSUER,
  NOW_MS,
  rpcRequest,
  userClaims,
  type TestIssuer,
} from "./helpers";

const ctx: McpToolCtx = {
  runQuery: vi.fn(),
  runMutation: vi.fn(),
  runAction: vi.fn(),
} as unknown as McpToolCtx;

const tools = {
  create_task: tool({
    description: "Creates a task for the signed-in user.",
    args: { title: v.string(), dueAt: v.optional(v.number()), priority: v.optional(v.int64()) },
    returns: v.object({ id: v.string(), title: v.string() }),
    annotations: { readOnlyHint: false },
    handler: (_ctx, args, caller) => ({
      id: "task_1",
      title: args.title,
      // Not in `returns`, so it must never reach the assistant.
      ownerEmail: "owner@example.com",
      owner: caller.tokenIdentifier,
      priority: args.priority,
    }),
  }),
  whoami: tool({
    description: "Names the caller.",
    args: {},
    principals: ["user", "agent"],
    handler: (_ctx, _args, caller) =>
      caller.principal === "user" ? caller.tokenIdentifier : `agent ${caller.agentId}`,
  }),
  fail_for_model: tool({
    description: "Fails with a message for the model.",
    args: {},
    handler: () => {
      throw new McpToolError("That slot is taken. Offer another time.");
    },
  }),
  fail_convex: tool({
    description: "Fails the way a Convex function does.",
    args: {},
    handler: () => {
      throw new ConvexError("You have reached your task limit.");
    },
  }),
  fail_internal: tool({
    description: "Fails with an internal error.",
    args: {},
    handler: () => {
      throw new Error("secret database detail");
    },
  }),
  bad_result: tool({
    description: "Returns the wrong shape.",
    args: {},
    returns: v.object({ id: v.string() }),
    handler: () => ({ id: 7 }) as unknown as { id: string },
  }),
};

interface RpcBody {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
    tools?: { name: string; inputSchema: unknown; outputSchema?: unknown }[];
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}

let issuer: TestIssuer;
let handle: (request: Request) => Promise<Response>;

async function rpc(token: string, method: string, params?: unknown): Promise<RpcBody> {
  const response = await handle(rpcRequest(token, { jsonrpc: "2.0", id: 1, method, params }));
  expect(response.status).toBe(200);
  return (await response.json()) as RpcBody;
}

beforeEach(async () => {
  issuer = await createTestIssuer();
  const handler = createMcpHandler<McpToolCtx>({
    name: "tasks",
    tools,
    verifier: createTokenVerifier({
      issuer: ISSUER,
      audiences: [AUDIENCE],
      fetch: issuer.fetch,
      now: () => NOW_MS,
    }),
    describeError: (error) =>
      error instanceof ConvexError && typeof error.data === "string" ? error.data : null,
  });
  handle = (request) => handler(request, ctx);
});

describe("validatorToJsonSchema", () => {
  it("converts each validator kind", () => {
    const schema = validatorToJsonSchema(
      v.object({
        name: v.string(),
        count: v.number(),
        big: v.int64(),
        done: v.boolean(),
        nothing: v.null(),
        blob: v.bytes(),
        owner: v.id("users"),
        kind: v.union(v.literal("a"), v.literal("b")),
        tags: v.array(v.string()),
        scores: v.record(v.string(), v.number()),
        note: v.optional(v.string()),
        anything: v.any(),
      }),
    );
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "count",
        "big",
        "done",
        "nothing",
        "blob",
        "owner",
        "kind",
        "tags",
        "scores",
        "anything",
      ],
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        big: {
          type: "string",
          pattern: "^-?[0-9]+$",
          description: "A 64-bit integer, written as a decimal string",
        },
        done: { type: "boolean" },
        nothing: { type: "null" },
        blob: { type: "string", contentEncoding: "base64" },
        owner: { type: "string", description: 'The id of a document in the "users" table' },
        kind: { anyOf: [{ const: "a" }, { const: "b" }] },
        tags: { type: "array", items: { type: "string" } },
        scores: { type: "object", additionalProperties: { type: "number" } },
        note: { type: "string" },
        anything: {},
      },
    });
  });
});

describe("tools over the handler", () => {
  it("lists tools with their schemas", async () => {
    const body = await rpc(await issuer.sign(userClaims()), "tools/list");
    const listed = body.result?.tools?.find((entry) => entry.name === "create_task");
    expect(listed).toMatchObject({
      inputSchema: { type: "object", required: ["title"], additionalProperties: false },
      outputSchema: { type: "object", required: ["id", "title"] },
    });
  });

  it("runs a tool as the token's user and returns only the declared fields", async () => {
    const body = await rpc(await issuer.sign(userClaims()), "tools/call", {
      name: "create_task",
      arguments: { title: "Ship it" },
    });
    expect(body.result?.structuredContent).toEqual({ id: "task_1", title: "Ship it" });
    expect(body.result?.content?.[0]?.text).not.toContain("owner@example.com");
    expect(body.result?.isError).toBeUndefined();
  });

  it("converts a decimal string to a bigint for an int64 argument", async () => {
    const seen: unknown[] = [];
    const handler = createMcpHandler<McpToolCtx>({
      name: "tasks",
      tools: {
        echo: tool({
          description: "Records its argument.",
          args: { priority: v.int64(), blob: v.bytes() },
          handler: (_ctx, args) => {
            seen.push(args.priority, new Uint8Array(args.blob)[0]);
            return "ok";
          },
        }),
      },
      verifier: createTokenVerifier({
        issuer: ISSUER,
        audiences: [AUDIENCE],
        fetch: issuer.fetch,
        now: () => NOW_MS,
      }),
    });
    const response = await handler(
      rpcRequest(await issuer.sign(userClaims()), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { priority: "9007199254740993", blob: btoa("A") } },
      }),
      ctx,
    );
    expect(((await response.json()) as RpcBody).result?.isError).toBeUndefined();
    expect(seen).toEqual([9007199254740993n, 65]);
  });

  it.each([
    ["a missing field", {}, "args.title: expected a value"],
    ["a wrong type", { title: 5 }, "args.title: expected a string"],
    ["an unknown field", { title: "x", userId: "u" }, "args.userId: expected no such field"],
    ["a bad integer", { title: "x", priority: "1.5" }, "args.priority: expected an integer"],
  ])("tells the model about %s", async (_name, args, message) => {
    const body = await rpc(await issuer.sign(userClaims()), "tools/call", {
      name: "create_task",
      arguments: args,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(message);
  });

  it("passes on messages written for the model", async () => {
    const token = await issuer.sign(userClaims());
    const forModel = await rpc(token, "tools/call", { name: "fail_for_model" });
    expect(forModel.result).toMatchObject({
      isError: true,
      content: [{ text: "That slot is taken. Offer another time." }],
    });
    const convex = await rpc(token, "tools/call", { name: "fail_convex" });
    expect(convex.result?.content?.[0]?.text).toBe("You have reached your task limit.");
  });

  it("hides internal errors and results of the wrong shape", async () => {
    const token = await issuer.sign(userClaims());
    for (const name of ["fail_internal", "bad_result"]) {
      const body = await rpc(token, "tools/call", { name });
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/^The tool failed/);
    }
  });

  it("shows an agent with no end user only the tools that opted in", async () => {
    const token = await issuer.sign(
      userClaims({ sub: "agent:agt_1", hercules_principal: "agent" }),
    );
    const listed = await rpc(token, "tools/list");
    expect(listed.result?.tools?.map((entry) => entry.name)).toEqual(["whoami"]);

    const allowed = await rpc(token, "tools/call", { name: "whoami" });
    expect(allowed.result?.content?.[0]?.text).toBe("agent agt_1");

    const refused = await rpc(token, "tools/call", {
      name: "create_task",
      arguments: { title: "x" },
    });
    expect(refused.error).toEqual({ code: -32602, message: "Unknown tool: create_task" });
  });
});

describe("an inspection token", () => {
  it("lists every tool with who may call it, and calls none", async () => {
    const token = await issuer.sign(
      userClaims({ sub: "agent:agt_1", hercules_principal: "agent", hercules_inspect: true }),
    );
    const response = await handle(
      rpcRequest(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const body = (await response.json()) as {
      result: { tools: { name: string; _meta?: Record<string, unknown> }[] };
    };
    expect(body.result.tools).toHaveLength(Object.keys(tools).length);
    const byName = new Map(body.result.tools.map((entry) => [entry.name, entry._meta]));
    expect(byName.get("create_task")).toEqual({ "hercules.app/principals": ["user"] });
    expect(byName.get("whoami")).toEqual({ "hercules.app/principals": ["user", "agent"] });

    const called = await rpc(token, "tools/call", { name: "whoami" });
    expect(called.error).toEqual({
      code: -32600,
      message: "An inspection token cannot call tools",
    });
  });

  it("is the only listing that carries the principals", async () => {
    const body = await rpc(await issuer.sign(userClaims()), "tools/list");
    expect(JSON.stringify(body)).not.toContain("hercules.app/principals");
  });
});

describe("defineMcpServer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes a default server at /mcp and a named one at /mcp/<name>", () => {
    expect(defineMcpServer({ tools: {} })).toMatchObject({ name: "default", path: "/mcp" });
    expect(defineMcpServer({ name: "support", tools: {} })).toMatchObject({
      name: "support",
      path: "/mcp/support",
    });
    expect(defineMcpServer({ name: "support", path: "/agents", tools: {} }).path).toBe("/agents");
  });

  it("refuses names that would not route or list", () => {
    expect(() => defineMcpServer({ name: "My Server", tools: {} })).toThrow(/server name/);
    expect(() => defineMcpServer({ tools: { "bad name": tools.whoami } })).toThrow(/tool name/);
  });

  it("registers POST and GET on the router", () => {
    const route = vi.fn();
    defineMcpServer({ name: "support", tools: {} }).registerRoutes({ route } as never);
    expect(route.mock.calls.map(([spec]) => [spec.path, spec.method])).toEqual([
      ["/mcp/support", "POST"],
      ["/mcp/support", "GET"],
    ]);
  });

  it("reads its issuer and audience from the deployment's environment", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site");
    vi.stubGlobal("fetch", issuer.fetch);
    const server = defineMcpServer({ tools: { whoami: tools.whoami } });

    // `exp` is checked against the real clock here, so sign for the real now.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await issuer.sign(userClaims({ iat: nowSeconds, exp: nowSeconds + 600 }));
    const response = await server.handle(
      ctx,
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami" },
      }),
    );
    const body = (await response.json()) as RpcBody;
    expect(body.result?.content?.[0]?.text).toBe(`${ISSUER}|user_123`);

    const elsewhere = await issuer.sign(
      userClaims({ aud: "https://other.convex.site/mcp", exp: nowSeconds + 600 }),
    );
    const refused = await server.handle(
      ctx,
      rpcRequest(elsewhere, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(refused.status).toBe(401);
  });

  it("answers 500 when the deployment has no auth configured", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", "");
    vi.stubEnv("CONVEX_SITE_URL", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = defineMcpServer({ tools: {} });
    const response = await server.handle(ctx, rpcRequest(null, {}));
    expect(response.status).toBe(500);
    errors.mockRestore();
  });

  it("hands tools only the three run calls", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site");
    vi.stubGlobal("fetch", issuer.fetch);
    let seen: string[] = [];
    const server = defineMcpServer({
      tools: {
        peek: tool({
          description: "Records what its context offers.",
          args: {},
          handler: (toolCtx) => {
            seen = Object.keys(toolCtx).sort();
            return "ok";
          },
        }),
      },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await issuer.sign(userClaims({ exp: nowSeconds + 600 }));
    await server.handle(
      { ...ctx, auth: {}, storage: {}, scheduler: {} } as unknown as McpToolCtx,
      rpcRequest(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "peek" } }),
    );
    expect(seen).toEqual(["runAction", "runMutation", "runQuery"]);
  });
});
