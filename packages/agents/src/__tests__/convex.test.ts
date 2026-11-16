import { ConvexError, v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTools, ToolError, tool, validatorToJsonSchema, type ToolCtx } from "../convex";
import { createTokenVerifier } from "../jwt";
import { createMcpHandler, type JsonSchema, type McpTool } from "../server";
import {
  AUDIENCE,
  createTestIssuer,
  ISSUER,
  NOW_MS,
  rpcRequest,
  userClaims,
  type TestIssuer,
} from "./helpers";

// An agent's id is a plain ULID.
const AGENT_ID = "01JDX5ZQ8W3J2K6M9N4P7R1S0T";

const ctx: ToolCtx = {
  runQuery: vi.fn(),
  runMutation: vi.fn(),
  runAction: vi.fn(),
} as unknown as ToolCtx;

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
      throw new ToolError("That slot is taken. Offer another time.");
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
    tools?: { name: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }[];
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
  const handler = createMcpHandler<ToolCtx>({
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
    const handler = createMcpHandler<ToolCtx>({
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
      userClaims({ sub: `agent:${AGENT_ID}`, hercules_principal: "agent" }),
    );
    const listed = await rpc(token, "tools/list");
    expect(listed.result?.tools?.map((entry) => entry.name)).toEqual(["whoami"]);

    const allowed = await rpc(token, "tools/call", { name: "whoami" });
    expect(allowed.result?.content?.[0]?.text).toBe(`agent ${AGENT_ID}`);

    const refused = await rpc(token, "tools/call", {
      name: "create_task",
      arguments: { title: "x" },
    });
    expect(refused.error).toEqual({ code: -32602, message: "Unknown tool: create_task" });
  });
});

/**
 * What an MCP client's 2025-11-25 codec requires of a `tools/list` result
 * before it shows any tool: a tool's input schema, and its output schema
 * when it has one, must have `type: "object"` at the root. One tool that
 * breaks the rule fails the whole listing.
 */
function listingProblems(listed: NonNullable<RpcBody["result"]>["tools"]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(listed)) return ["tools is not an array"];
  for (const entry of listed) {
    if (typeof entry.name !== "string") problems.push("a tool has no name");
    if (entry.inputSchema?.["type"] !== "object") {
      problems.push(`${entry.name}: inputSchema.type is not "object"`);
    }
    if ("outputSchema" in entry && entry.outputSchema?.["type"] !== "object") {
      problems.push(`${entry.name}: outputSchema.type is not "object"`);
    }
  }
  return problems;
}

describe("what a tool returns, as MCP lists and sends it", () => {
  const order = v.object({ id: v.string(), total: v.number() });
  const shaped = {
    one_order: tool({
      description: "An object.",
      args: {},
      returns: order,
      handler: () => ({ id: "a", total: 1, secret: "x" }),
    }),
    totals_by_id: tool({
      description: "A record.",
      args: {},
      returns: v.record(v.string(), v.number()),
      handler: () => ({ a: 1 }),
    }),
    list_orders: tool({
      description: "An array.",
      args: {},
      returns: v.array(order),
      handler: () => [{ id: "a", total: 1, secret: "x" }],
    }),
    order_name: tool({
      description: "A string.",
      args: {},
      returns: v.string(),
      handler: () => "Order a",
    }),
    maybe_order: tool({
      description: "A union.",
      args: {},
      returns: v.union(order, v.null()),
      handler: () => ({ id: "a", total: 1, secret: "x" }),
    }),
    no_order: tool({
      description: "A union, answering null.",
      args: {},
      returns: v.union(order, v.null()),
      handler: () => null,
    }),
    untyped: tool({ description: "No returns.", args: {}, handler: () => ({ id: "a" }) }),
  };

  function serve(served: Record<string, McpTool<ToolCtx>>) {
    const handler = createMcpHandler<ToolCtx>({
      name: "orders",
      tools: served,
      verifier: createTokenVerifier({
        issuer: ISSUER,
        audiences: [AUDIENCE],
        fetch: issuer.fetch,
        now: () => NOW_MS,
      }),
    });
    return async (method: string, params?: unknown) => {
      const response = await handler(
        rpcRequest(await issuer.sign(userClaims()), { jsonrpc: "2.0", id: 1, method, params }),
        ctx,
      );
      return (await response.json()) as RpcBody;
    };
  }

  it("lists an output schema only for a tool that returns an object", async () => {
    const listed = (await serve(shaped)("tools/list")).result?.tools;
    expect(listingProblems(listed)).toEqual([]);
    const withSchema = listed?.flatMap((entry) => ("outputSchema" in entry ? [entry.name] : []));
    expect(withSchema).toEqual(["one_order", "totals_by_id"]);
  });

  it("the check fails on a listing a client would refuse", () => {
    expect(
      listingProblems([
        { name: "ok", inputSchema: { type: "object" } },
        { name: "list", inputSchema: { type: "object" }, outputSchema: { type: "array" } },
        { name: "maybe", inputSchema: { type: "object" }, outputSchema: { anyOf: [] } },
      ]),
    ).toEqual([
      'list: outputSchema.type is not "object"',
      'maybe: outputSchema.type is not "object"',
    ]);
  });

  it("sends structured content with a listed schema, and only then", async () => {
    const call = serve(shaped);
    const listed = (await call("tools/list")).result?.tools ?? [];
    for (const entry of listed) {
      const { result } = await call("tools/call", { name: entry.name });
      expect(result?.isError).toBeUndefined();
      expect(result?.content).toHaveLength(1);
      const structured = result !== undefined && "structuredContent" in result;
      expect([entry.name, structured]).toEqual([entry.name, "outputSchema" in entry]);
      // The text is the same value, for a client that does not read structured content.
      if (structured) {
        expect(JSON.parse(result?.content?.[0]?.text ?? "")).toEqual(result?.structuredContent);
      }
    }
    expect((await call("tools/call", { name: "one_order" })).result?.structuredContent).toEqual({
      id: "a",
      total: 1,
    });
    expect((await call("tools/call", { name: "totals_by_id" })).result?.structuredContent).toEqual({
      a: 1,
    });
  });

  it("still enforces returns on a tool it sends as text", async () => {
    const call = serve(shaped);
    const text = async (name: string) =>
      (await call("tools/call", { name })).result?.content?.[0]?.text;
    expect(await text("list_orders")).toBe('[{"id":"a","total":1}]');
    expect(await text("maybe_order")).toBe('{"id":"a","total":1}');
    expect(await text("no_order")).toBe("null");
    expect(await text("order_name")).toBe("Order a");
  });

  it("never lists a schema that is not an object, whoever built the tool", async () => {
    const base: McpTool<ToolCtx> = {
      description: "Built without the adapter.",
      inputSchema: { type: "object" },
      parseArgs: (raw) => raw,
      handler: () => [1, 2],
    };
    const call = serve({
      listed_wrong: { ...base, outputSchema: { type: "array", items: { type: "number" } } },
      promised_object: { ...base, outputSchema: { type: "object" } },
    });
    const listed = (await call("tools/list")).result?.tools;
    expect(listingProblems(listed)).toEqual([]);
    expect(listed?.find((entry) => entry.name === "listed_wrong")).not.toHaveProperty(
      "outputSchema",
    );
    expect((await call("tools/call", { name: "listed_wrong" })).result).toEqual({
      content: [{ type: "text", text: "[1,2]" }],
    });
    // A schema that promises an object is not answered with anything else.
    const broken = (await call("tools/call", { name: "promised_object" })).result;
    expect(broken?.isError).toBe(true);
    expect(broken).not.toHaveProperty("structuredContent");
  });
});

describe("an inspection token", () => {
  it("lists every tool with who may call it, and calls none", async () => {
    const token = await issuer.sign(
      userClaims({ sub: `agent:${AGENT_ID}`, hercules_principal: "agent", hercules_inspect: true }),
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

describe("defineTools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes a default server at /mcp and a named one at /mcp/<name>", () => {
    expect(defineTools({ tools: {} })).toMatchObject({ name: "default", path: "/mcp" });
    expect(defineTools({ name: "support", tools: {} })).toMatchObject({
      name: "support",
      path: "/mcp/support",
    });
    // Those are the only paths Hercules calls, so there is no other to choose.
    expect(defineTools({ name: "support", path: "/agents", tools: {} } as never).path).toBe(
      "/mcp/support",
    );
  });

  it("refuses names that would not route or list", () => {
    expect(() => defineTools({ name: "My Server", tools: {} })).toThrow(/server name/);
    expect(() => defineTools({ tools: { "bad name": tools.whoami } })).toThrow(/tool name/);
  });

  it("registers POST and GET on the router", () => {
    const route = vi.fn();
    defineTools({ name: "support", tools: {} }).registerRoutes({ route } as never);
    expect(route.mock.calls.map(([spec]) => [spec.path, spec.method])).toEqual([
      ["/mcp/support", "POST"],
      ["/mcp/support", "GET"],
    ]);
  });

  it("reads its issuer and audience from the deployment's environment", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site");
    vi.stubGlobal("fetch", issuer.fetch);
    const server = defineTools({ tools: { whoami: tools.whoami } });

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

  it("takes a token for the deployment's .convex.site URL behind a custom domain", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    // The app serves its HTTP actions from its own domain.
    vi.stubEnv("CONVEX_SITE_URL", "https://api.example.com");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    vi.stubGlobal("fetch", issuer.fetch);
    const server = defineTools({ tools: { whoami: tools.whoami } });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } };
    // Hercules signs for the deployment's own URL, whatever domain the app added.
    for (const aud of ["https://happy-otter-123.convex.site/mcp", "https://api.example.com/mcp"]) {
      const token = await issuer.sign(userClaims({ aud, iat: nowSeconds, exp: nowSeconds + 600 }));
      expect((await server.handle(ctx, rpcRequest(token, call))).status).toBe(200);
    }
    const other = await issuer.sign(
      userClaims({ aud: "https://sad-otter-999.convex.site/mcp", exp: nowSeconds + 600 }),
    );
    expect((await server.handle(ctx, rpcRequest(other, call))).status).toBe(401);
  });

  it("answers 503, not 401, to every request while the issuer's keys cannot be fetched", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site");
    vi.stubGlobal("fetch", issuer.fetch);
    const server = defineTools({ tools: { whoami: tools.whoami } });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await issuer.sign(userClaims({ iat: nowSeconds, exp: nowSeconds + 600 }));
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } };
    issuer.setReachable(false);
    // The first request finds the issuer down, and the second comes before
    // the keys may be fetched again: neither says anything about the token.
    for (let request = 0; request < 2; request++) {
      const response = await server.handle(ctx, rpcRequest(token, call));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    }
  });

  it("answers 500 when the deployment has no auth configured", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", "");
    vi.stubEnv("CONVEX_SITE_URL", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = defineTools({ tools: {} });
    const response = await server.handle(ctx, rpcRequest(null, {}));
    expect(response.status).toBe(500);
    errors.mockRestore();
  });

  it("hands tools only the three run calls", async () => {
    vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site");
    vi.stubGlobal("fetch", issuer.fetch);
    let seen: string[] = [];
    const server = defineTools({
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
      { ...ctx, auth: {}, storage: {}, scheduler: {} } as unknown as ToolCtx,
      rpcRequest(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "peek" } }),
    );
    expect(seen).toEqual(["runAction", "runMutation", "runQuery"]);
  });
});
