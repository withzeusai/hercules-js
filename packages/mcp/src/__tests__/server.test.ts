import { beforeEach, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../jwt";
import { callerFromToken, createMcpHandler, McpToolError, type McpTool } from "../server";
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
      big: { ...echo, handler: () => ({ count: 12n, bytes: new Uint8Array([65, 66]).buffer }) },
      refuse: {
        ...echo,
        parseArgs: () => {
          throw new McpToolError("Invalid arguments.");
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

describe("callerFromToken", () => {
  const base = { issuer: ISSUER, subject: "user_123" };

  it("reads an end user, with the agent acting for them when there is one", () => {
    expect(callerFromToken({ ...base, claims: {} })).toEqual({
      principal: "user",
      tokenIdentifier: `${ISSUER}|user_123`,
      issuer: ISSUER,
      subject: "user_123",
      agentId: null,
    });
    expect(callerFromToken({ ...base, claims: { hercules_actor: "agent:agt_1" } })).toMatchObject({
      principal: "user",
      agentId: "agt_1",
    });
  });

  it("reads an agent with no end user, and the visitor it serves", () => {
    expect(
      callerFromToken({
        issuer: ISSUER,
        subject: "agent:agt_1",
        claims: { hercules_principal: "agent", hercules_visitor: "anonymous:v1" },
      }),
    ).toEqual({ principal: "agent", agentId: "agt_1", visitorId: "anonymous:v1" });
  });

  it.each([
    ["an agent subject without the agent principal", "agent:agt_1", {}],
    ["the agent principal on a user subject", "user_123", { hercules_principal: "agent" }],
    ["an unknown principal", "user_123", { hercules_principal: "service" }],
  ])("refuses %s", (_name, subject, claims) => {
    expect(callerFromToken({ issuer: ISSUER, subject, claims })).toBeNull();
  });
});
