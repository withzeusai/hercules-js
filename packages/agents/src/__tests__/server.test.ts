import { beforeEach, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../jwt";
import {
  callerFromToken,
  checkToolAccess,
  createMcpHandler,
  ToolError,
  type McpTool,
} from "../server";
import {
  AUDIENCE,
  createTestIssuer,
  ISSUER,
  NOW_MS,
  NOW_SECONDS,
  rpcRequest,
  userClaims,
  type TestIssuer,
} from "./helpers";

// An agent's id is a plain ULID.
const AGENT_ID = "01JDX5ZQ8W3J2K6M9N4P7R1S0T";

const echo: McpTool<null> = {
  description: "Returns its arguments.",
  inputSchema: { type: "object" },
  parseArgs: (raw) => raw,
  handler: (_ctx, args: never) => args,
};

let issuer: TestIssuer;
let handle: (request: Request) => Promise<Response>;

beforeEach(async () => {
  issuer = await createTestIssuer();
  const handler = createMcpHandler<null>({
    name: "tasks",
    instructions: "Use create_task for new work.",
    tools: {
      echo,
      text: { ...echo, handler: () => "plain text" },
      caller: {
        ...echo,
        principals: ["user", "agent"],
        handler: (_ctx, _args: never, caller) => caller,
      },
      // Takes the app's own job, and runs its schedules and triggers start.
      caller_listed: {
        ...echo,
        principals: ["user", "agent"],
        agentOrigins: ["app", "schedule", "trigger"],
        handler: (_ctx, _args: never, caller) => caller,
      },
      // Names the origin Hercules signs for a run it cannot classify.
      caller_other: {
        ...echo,
        principals: ["agent"],
        agentOrigins: ["app", "other"],
        handler: (_ctx, _args: never, caller) => caller,
      },
      // As every tool that listed "agent" was before origins: any call with no end user.
      caller_any: {
        ...echo,
        principals: ["agent"],
        agentOrigins: "any",
        handler: (_ctx, _args: never, caller) => caller,
      },
      big: { ...echo, handler: () => ({ count: 12n, bytes: new Uint8Array([65, 66]).buffer }) },
      refuse: {
        ...echo,
        parseArgs: () => {
          throw new ToolError("Invalid arguments.");
        },
      },
    },
    verifier: createTokenVerifier({
      issuer: ISSUER,
      audiences: [AUDIENCE],
      fetch: issuer.fetch,
      now: () => NOW_MS,
    }),
  });
  handle = (request) => handler(request, null);
});

async function send(body: unknown, token?: string | null) {
  const bearer = token === undefined ? await issuer.sign(userClaims()) : token;
  return handle(rpcRequest(bearer, body));
}

describe("createMcpHandler", () => {
  it("refuses a request with no token before reading it", async () => {
    const response = await send({ jsonrpc: "2.0", id: 1, method: "initialize" }, null);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("says why a token was refused", async () => {
    const expired = await issuer.sign(userClaims({ exp: NOW_SECONDS - 600 }));
    const response = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, expired);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", error_description="The token has expired"',
    );
  });

  it("refuses a token that does not say who is calling", async () => {
    const { hercules_principal: _principal, ...claims } = userClaims();
    const response = await send(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      await issuer.sign(claims),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", error_description="The token is not a valid JWT"',
    );
  });

  it("takes an agent's token that still carries hercules_visitor as an agent with no end user", async () => {
    const claims = userClaims({
      sub: `agent:${AGENT_ID}`,
      hercules_principal: "agent",
      hercules_origin: "app",
    });
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "caller" } };
    // The second is what a Hercules that has not dropped the claim yet signs
    // for a thread a visitor of a public agent once opened.
    for (const signed of [claims, { ...claims, hercules_visitor: "anonymous:v1" }]) {
      const token = await issuer.sign(signed);
      const response = await send(call, token);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { result: unknown }).result).toEqual({
        content: [
          {
            type: "text",
            text: `{"principal":"agent","agentId":"${AGENT_ID}","origin":"app"}`,
          },
        ],
      });
      // It is no end user: a tool for signed-in users does not exist for it.
      const refused = await send({ ...call, params: { name: "echo" } }, token);
      expect(((await refused.json()) as { error: unknown }).error).toEqual({
        code: -32602,
        message: "Unknown tool: echo",
      });
    }
  });

  it("answers 503 while the signing keys cannot be loaded", async () => {
    issuer.setReachable(false);
    const response = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("answers 405 to anything but POST", async () => {
    const response = await handle(rpcRequest(null, null, { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("negotiates the protocol version", async () => {
    const known = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(await known.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tasks", version: "1.0.0" },
        instructions: "Use create_task for new work.",
      },
    });

    const unknown = await send({
      jsonrpc: "2.0",
      id: "a",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const body = (await unknown.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("accepts notifications without answering them", async () => {
    const response = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers ping", async () => {
    const response = await send({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it.each([
    ["text that is not JSON", "{", 400, -32700],
    ["a batch", [{ jsonrpc: "2.0", id: 1, method: "ping" }], 400, -32600],
    ["a message with no method", { jsonrpc: "2.0", id: 1 }, 400, -32600],
    ["an unknown method", { jsonrpc: "2.0", id: 1, method: "resources/list" }, 200, -32601],
    [
      "an unknown tool",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } },
      200,
      -32602,
    ],
  ])("rejects %s", async (_name, body, status, code) => {
    const response = await send(body);
    expect(response.status).toBe(status);
    const parsed = (await response.json()) as { error: { code: number } };
    expect(parsed.error.code).toBe(code);
  });

  it("returns a string result as text and an object as JSON", async () => {
    const text = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "text" },
    });
    expect(((await text.json()) as { result: unknown }).result).toEqual({
      content: [{ type: "text", text: "plain text" }],
    });

    const object = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    expect(((await object.json()) as { result: unknown }).result).toEqual({
      content: [{ type: "text", text: '{"a":1}' }],
    });
  });

  it("writes bigints as decimal strings and bytes as base64", async () => {
    const response = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "big" },
    });
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]?.text).toBe('{"count":"12","bytes":"QUI="}');
  });

  it("reports refused arguments as a tool error", async () => {
    const response = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "refuse" },
    });
    expect(((await response.json()) as { result: unknown }).result).toEqual({
      content: [{ type: "text", text: "Invalid arguments." }],
      isError: true,
    });
  });
});

describe("where a call with no end user came from", () => {
  const AGENT_TOOLS = ["caller", "caller_listed", "caller_other", "caller_any"];

  async function agentToken(origin?: unknown) {
    return issuer.sign(
      userClaims({
        sub: `agent:${AGENT_ID}`,
        hercules_principal: "agent",
        ...(origin !== undefined && { hercules_origin: origin }),
      }),
    );
  }

  /** The tools a token is listed, and the ones it can call: the two must be the same. */
  async function reach(token: string) {
    const listing = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    const listed = (
      (await listing.json()) as { result: { tools: { name: string }[] } }
    ).result.tools
      .map((entry) => entry.name)
      .filter((name) => AGENT_TOOLS.includes(name));
    const callable: string[] = [];
    for (const name of AGENT_TOOLS) {
      const response = await send(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } },
        token,
      );
      const body = (await response.json()) as { result?: unknown; error?: { message: string } };
      if (body.result !== undefined) callable.push(name);
      // A tool that does not take the caller is one that does not exist for it.
      else expect(body.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
    }
    expect(listed).toEqual(callable);
    return callable;
  }

  it.each([
    // The app's own job: every tool that lists "agent" takes it.
    ["app", ["caller", "caller_listed", "caller_other", "caller_any"]],
    // Any other origin: only a tool that names it, or takes any.
    ["schedule", ["caller_listed", "caller_any"]],
    ["trigger", ["caller_listed", "caller_any"]],
    ["organization", ["caller_any"]],
    ["console", ["caller_any"]],
    ["channel", ["caller_any"]],
    ["test", ["caller_any"]],
    // What Hercules signs for a run it cannot classify. Never taken by
    // default: only by a tool that names it, or takes any.
    ["other", ["caller_other", "caller_any"]],
    // An origin added after this version was built. It is not read as
    // "other": the tool that names "other" does not take it.
    ["webhook", ["caller_any"]],
    // Near misses are not `app`.
    ["App", ["caller_any"]],
    ["app ", ["caller_any"]],
  ])("origin %j reaches %j", async (origin, tools) => {
    expect(await reach(await agentToken(origin))).toEqual(tools);
  });

  it.each([
    ["no origin claim", undefined],
    ["an empty origin", ""],
    ["an origin that is not a name", { is: "app" }],
    ["a list of origins", ["app"]],
  ])(
    "takes a token with %s for no one's own job: only a tool that takes any origin",
    async (_name, origin) => {
      expect(await reach(await agentToken(origin))).toEqual(["caller_any"]);
    },
  );

  it("hands the tool the origin, to branch on", async () => {
    for (const [origin, expected] of [
      ["schedule", "schedule"],
      ["webhook", "webhook"],
      [undefined, null],
    ] as const) {
      const response = await send(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "caller_any" } },
        await agentToken(origin),
      );
      const body = (await response.json()) as { result: { content: { text: string }[] } };
      expect(JSON.parse(body.result.content[0]!.text)).toEqual({
        principal: "agent",
        agentId: AGENT_ID,
        origin: expected,
      });
    }
  });

  it("changes nothing for a signed-in user, with an agent acting for them or not", async () => {
    for (const claims of [
      userClaims(),
      userClaims({ hercules_actor: `agent:${AGENT_ID}` }),
      // An origin on a user's token is not read.
      userClaims({ hercules_actor: `agent:${AGENT_ID}`, hercules_origin: "console" }),
    ]) {
      // Every tool that lists "user", whatever it says of agents.
      expect(await reach(await issuer.sign(claims))).toEqual(["caller", "caller_listed"]);
    }
    const response = await send(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "caller" } },
      await issuer.sign(userClaims({ hercules_origin: "console" })),
    );
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      principal: "user",
      tokenIdentifier: `${ISSUER}|user_123`,
      issuer: ISSUER,
      subject: "user_123",
      agentId: null,
    });
  });

  it("lists each tool's origins to an inspection token, which can call none", async () => {
    const token = await issuer.sign(
      userClaims({ sub: `agent:${AGENT_ID}`, hercules_principal: "agent", hercules_inspect: true }),
    );
    const response = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    const tools = (
      (await response.json()) as { result: { tools: { name: string; _meta: unknown }[] } }
    ).result.tools;
    const meta = Object.fromEntries(tools.map((entry) => [entry.name, entry._meta]));
    expect(meta["echo"]).toEqual({ "hercules.app/principals": ["user"] });
    expect(meta["caller"]).toEqual({
      "hercules.app/principals": ["user", "agent"],
      "hercules.app/agent-origins": ["app"],
    });
    expect(meta["caller_listed"]).toEqual({
      "hercules.app/principals": ["user", "agent"],
      "hercules.app/agent-origins": ["app", "schedule", "trigger"],
    });
    expect(meta["caller_any"]).toEqual({
      "hercules.app/principals": ["agent"],
      "hercules.app/agent-origins": "any",
    });
  });

  it("refuses, when a tool is declared, origins that were not set on purpose", () => {
    const check = (tool: Partial<McpTool<null>>) => () =>
      checkToolAccess("report", { ...echo, ...tool } as McpTool<null>);
    // Only a tool that lists "agent" has origins to widen.
    expect(check({ agentOrigins: ["schedule"] })).toThrow(/does not list "agent"/);
    expect(check({ principals: ["user"], agentOrigins: "any" })).toThrow(/does not list "agent"/);
    expect(check({ principals: ["agent"], agentOrigins: [] })).toThrow(/is empty/);
    // Every origin is `"any"`, not an origin named "any".
    expect(check({ principals: ["agent"], agentOrigins: ["any"] })).toThrow(/agentOrigins: "any"/);
    expect(check({ principals: ["agent"], agentOrigins: "all" as never })).toThrow(
      /a list of origins/,
    );
    expect(check({ principals: ["agent"], agentOrigins: ["app", ""] })).toThrow(/by name/);
    expect(check({ principals: ["agent"], agentOrigins: [true] as never })).toThrow(/by name/);
    expect(check({ principals: ["agent"] })).not.toThrow();
    expect(check({ principals: ["agent"], agentOrigins: ["app", "webhook"] })).not.toThrow();
    // The handler refuses the same, so no adapter serves such a tool.
    expect(() =>
      createMcpHandler<null>({
        name: "tasks",
        tools: { report: { ...echo, agentOrigins: "any" } },
        verifier: { verify: async () => ({ ok: false, reason: "missing" }) },
      }),
    ).toThrow(/MCP tool "report": agentOrigins/);
  });
});

describe("callerFromToken", () => {
  const base = { issuer: ISSUER, subject: "user_123" };

  it("reads an end user, with the agent acting for them when there is one", () => {
    const claims = { hercules_principal: "user" };
    expect(callerFromToken({ ...base, claims })).toEqual({
      principal: "user",
      tokenIdentifier: `${ISSUER}|user_123`,
      issuer: ISSUER,
      subject: "user_123",
      agentId: null,
    });
    expect(
      callerFromToken({ ...base, claims: { ...claims, hercules_actor: `agent:${AGENT_ID}` } }),
    ).toMatchObject({ principal: "user", agentId: AGENT_ID });
  });

  it("reads where an agent's run was started, as the token says it or not at all", () => {
    const token = { issuer: ISSUER, subject: `agent:${AGENT_ID}` };
    const from = (claims: Record<string, unknown>) =>
      callerFromToken({ ...token, claims: { hercules_principal: "agent", ...claims } });
    expect(from({ hercules_origin: "app" })).toStrictEqual({
      principal: "agent",
      agentId: AGENT_ID,
      origin: "app",
    });
    // An origin added later is passed on by its name, and is not `app`.
    expect(from({ hercules_origin: "webhook" })).toMatchObject({ origin: "webhook" });
    // No claim, or one that is not a name: no origin. Never a guess.
    for (const claims of [
      {},
      { hercules_origin: "" },
      { hercules_origin: true },
      { hercules_origin: ["app"] },
    ]) {
      expect(from(claims)).toStrictEqual({ principal: "agent", agentId: AGENT_ID, origin: null });
    }
    // An end user's token carries no origin, whatever it claims.
    expect(
      callerFromToken({
        issuer: ISSUER,
        subject: "user_123",
        claims: { hercules_principal: "user", hercules_origin: "app" },
      }),
    ).not.toHaveProperty("origin");
  });

  it("reads an agent with no end user", () => {
    const token = { issuer: ISSUER, subject: `agent:${AGENT_ID}` };
    const agent = { principal: "agent", agentId: AGENT_ID, origin: null };
    expect(callerFromToken({ ...token, claims: { hercules_principal: "agent" } })).toStrictEqual(
      agent,
    );
    // A Hercules that still signs the claim it had for the visitor of a
    // public agent: the caller is the same, and carries nothing of it.
    expect(
      callerFromToken({
        ...token,
        claims: { hercules_principal: "agent", hercules_visitor: "anonymous:v1" },
      }),
    ).toStrictEqual(agent);
  });

  it.each([
    ["a token with no principal", "user_123", {}],
    ["a principal that is not text", "user_123", { hercules_principal: true }],
    [
      "an agent subject with the user principal",
      `agent:${AGENT_ID}`,
      { hercules_principal: "user" },
    ],
    ["the agent principal on a user subject", "user_123", { hercules_principal: "agent" }],
    ["an unknown principal", "user_123", { hercules_principal: "service" }],
  ])("refuses %s", (_name, subject, claims) => {
    expect(callerFromToken({ issuer: ISSUER, subject, claims })).toBeNull();
  });
});
