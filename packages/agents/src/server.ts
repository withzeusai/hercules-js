/**
 * The MCP server itself: a function from a web `Request` to a `Response`. It
 * knows nothing about the backend it runs on. An adapter (`./convex`) turns
 * the backend's validators into the tools this file serves and hands each
 * call the backend's context.
 *
 * Stateless Streamable HTTP: every request is one JSON-RPC message answered
 * with one JSON body. There are no sessions and no server-sent events.
 */
import { bearerTokenOf, type TokenFailure, type TokenVerifier } from "./jwt";

export type JsonSchema = Record<string, unknown>;

/** Hints a client may show or act on. They describe the tool; they do not restrict it. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolPrincipal = "user" | "agent";

/**
 * Who is calling a tool, taken from the verified token.
 *
 * - `user`: a signed-in end user of the app. `tokenIdentifier` is the same
 *   `<issuer>|<subject>` string the app stores for that user's web session.
 *   `agentId` is set when a Hercules agent makes the call on their behalf.
 * - `agent`: a Hercules agent acting for nobody the app knows (a run the
 *   organization, a schedule, or the app's own job started). There is no end
 *   user, so a tool only receives it after opting in with `principals`.
 */
export type ToolCaller =
  | {
      principal: "user";
      tokenIdentifier: string;
      issuer: string;
      subject: string;
      agentId: string | null;
    }
  | {
      principal: "agent";
      agentId: string;
      /**
       * @deprecated Hercules agents no longer take anonymous visitors, so
       * this is null on every new run. It is still set on a run in a thread
       * a visitor opened before that: treat a caller with one as an
       * anonymous member of the public, never as the app's own job. It will
       * be removed once Hercules no longer sends it.
       */
      visitorId: string | null;
    };

/** A failure the calling model should read and can act on. Its message is sent as is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** A tool as the server runs it. Adapters build these; apps use the adapter's `tool()`. */
export interface McpTool<Ctx> {
  description: string;
  inputSchema: JsonSchema;
  /**
   * What the tool returns, when that is an object. MCP takes only a schema
   * whose root `type` is `"object"`; any other is not listed, and the tool's
   * result goes out as text alone.
   */
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  /** Who may call the tool. Defaults to signed-in users only. */
  principals?: readonly ToolPrincipal[];
  /** Checks and converts the raw arguments. Throws `ToolError` when they do not fit. */
  parseArgs(raw: unknown): unknown;
  /** Checks the handler's result against what the tool declared it returns. */
  shapeResult?(value: unknown): unknown;
  handler(ctx: Ctx, args: never, caller: ToolCaller): unknown;
}

export interface McpHandlerOptions<Ctx> {
  /** The server's name, as clients display it. */
  name: string;
  version?: string;
  /** Guidance for the calling model on how to use this server's tools. */
  instructions?: string;
  tools: Readonly<Record<string, McpTool<Ctx>>>;
  verifier: TokenVerifier;
  /**
   * The message to send for an error a handler threw, or null to send a
   * generic one. Lets an adapter pass on its backend's user-facing errors.
   */
  describeError?: (error: unknown) => string | null;
}

/** Newest first. The first entry answers a client that asks for a version we do not speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const DEFAULT_PRINCIPALS: readonly ToolPrincipal[] = ["user"];
/** On each tool of an inspection listing: who may call it. */
export const PRINCIPALS_META_KEY = "hercules.app/principals";
const MAX_BODY_BYTES = 1_000_000;
const AGENT_SUBJECT_PREFIX = "agent:";
const GENERIC_TOOL_FAILURE = "The tool failed. Try again, or tell the user it is unavailable.";

type RpcId = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function rpcResult(id: RpcId, result: unknown): Response {
  return json(200, { jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcId | null, code: number, message: string, status = 200): Response {
  return json(status, { jsonrpc: "2.0", id, error: { code, message } });
}

const TOKEN_FAILURE_DESCRIPTIONS: Record<TokenFailure, string> = {
  missing: "No bearer token was sent",
  malformed: "The token is not a valid JWT",
  unsupported_algorithm: "The token is not signed with RS256",
  unknown_key: "The token is signed with a key this app's Hercules Auth does not publish",
  bad_signature: "The token signature does not verify",
  wrong_issuer: "The token was not issued by this app's Hercules Auth",
  wrong_audience: "The token was issued for a different server",
  expired: "The token has expired",
  not_yet_valid: "The token is not valid yet",
  keys_unavailable: "The signing keys could not be loaded",
};

function unauthorized(reason: TokenFailure): Response {
  if (reason === "keys_unavailable") {
    return json(503, { error: "temporarily_unavailable" }, { "retry-after": "5" });
  }
  const challenge =
    reason === "missing"
      ? "Bearer"
      : `Bearer error="invalid_token", error_description="${TOKEN_FAILURE_DESCRIPTIONS[reason]}"`;
  return json(401, { error: "unauthorized" }, { "www-authenticate": challenge });
}

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function agentIdOf(value: string | null): string | null {
  if (value === null || !value.startsWith(AGENT_SUBJECT_PREFIX)) return null;
  const id = value.slice(AGENT_SUBJECT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Reads the caller out of a verified token, or null when its claims do not
 * name one. `hercules_principal` is required: a token without it is refused,
 * never read as a user.
 */
export function callerFromToken(token: {
  issuer: string;
  subject: string;
  claims: Record<string, unknown>;
}): ToolCaller | null {
  const principal = stringClaim(token.claims, "hercules_principal");
  if (principal === "agent") {
    const agentId = agentIdOf(token.subject);
    if (agentId === null) return null;
    return {
      principal: "agent",
      agentId,
      visitorId: stringClaim(token.claims, "hercules_visitor"),
    };
  }
  if (principal !== "user") return null;
  // An agent subject without the agent principal would read as an end user
  // named "agent:…", which no app has.
  if (token.subject.startsWith(AGENT_SUBJECT_PREFIX)) return null;
  return {
    principal: "user",
    tokenIdentifier: `${token.issuer}|${token.subject}`,
    issuer: token.issuer,
    subject: token.subject,
    agentId: agentIdOf(stringClaim(token.claims, "hercules_actor")),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** JSON for a tool result. `bigint` becomes a decimal string and bytes become base64. */
function serializeResult(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(entry));
    if (ArrayBuffer.isView(entry)) {
      return bytesToBase64(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength));
    }
    return entry;
  });
}

/**
 * The schema a tool is listed with, or undefined. MCP (2025-11-25) requires
 * an output schema's root `type` to be `"object"`, and a client refuses the
 * whole listing over one that is not.
 */
function listedOutputSchema<Ctx>(tool: McpTool<Ctx>): JsonSchema | undefined {
  return tool.outputSchema?.["type"] === "object" ? tool.outputSchema : undefined;
}

/**
 * A tool's result. Structured content goes with a listed output schema and
 * only with one: a client checks it against that schema.
 */
function toolResult(value: unknown, structured: boolean) {
  if (structured && isRecord(value)) {
    const text = serializeResult(value);
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as unknown };
  }
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  return { content: [{ type: "text", text: serializeResult(value) }] };
}

function toolFailure(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function allows<Ctx>(tool: McpTool<Ctx>, caller: ToolCaller): boolean {
  return (tool.principals ?? DEFAULT_PRINCIPALS).includes(caller.principal);
}

/**
 * Builds the request handler for one MCP server. Call it once and reuse the
 * result: it holds the token verifier, which caches the issuer's keys.
 */
export function createMcpHandler<Ctx>(options: McpHandlerOptions<Ctx>) {
  const tools = new Map(Object.entries(options.tools));

  async function callTool(ctx: Ctx, caller: ToolCaller, params: unknown) {
    const name = isRecord(params) ? params["name"] : undefined;
    const tool = typeof name === "string" ? tools.get(name) : undefined;
    // A tool this caller may not use is reported like one that does not
    // exist, matching what `tools/list` showed them.
    if (tool === undefined || !allows(tool, caller)) return null;
    try {
      const raw = isRecord(params) ? (params["arguments"] ?? {}) : {};
      const args = tool.parseArgs(raw);
      const value: unknown = await tool.handler(ctx, args as never, caller);
      const shaped = tool.shapeResult ? tool.shapeResult(value) : value;
      const structured = listedOutputSchema(tool) !== undefined;
      // A listed schema promises an object; anything else is the tool's bug.
      if (structured && !isRecord(shaped)) throw new Error("The tool did not return an object");
      return toolResult(shaped, structured);
    } catch (error) {
      // A failed tool is a result the model reads and recovers from, not a
      // protocol error. Only messages written for the model are passed on.
      if (error instanceof ToolError) return toolFailure(error.message);
      return toolFailure(options.describeError?.(error) ?? GENERIC_TOOL_FAILURE);
    }
  }

  return async function handleMcpRequest(request: Request, ctx: Ctx): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    const verified = await options.verifier.verify(bearerTokenOf(request));
    if (!verified.ok) return unauthorized(verified.reason);
    const caller = callerFromToken(verified.token);
    if (caller === null) return unauthorized("malformed");
    // An inspection token is how Hercules checks a server while the app is
    // being built: it lists every tool and can call none.
    const inspecting = verified.token.claims["hercules_inspect"] === true;

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return rpcError(null, -32600, "Request too large", 413);
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }
    if (
      !isRecord(message) ||
      message["jsonrpc"] !== "2.0" ||
      typeof message["method"] !== "string"
    ) {
      return rpcError(null, -32600, "Invalid request", 400);
    }

    const { id, method, params } = message;
    // No id makes it a notification (`notifications/initialized`): accepted, never answered.
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    if (typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, -32600, "Invalid request", 400);
    }

    switch (method) {
      case "initialize": {
        const requested = isRecord(params) ? params["protocolVersion"] : undefined;
        const protocolVersion =
          SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ??
          SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: options.name, version: options.version ?? "1.0.0" },
          ...(options.instructions !== undefined && { instructions: options.instructions }),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: [...tools]
            .filter(([, tool]) => inspecting || allows(tool, caller))
            .map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(listedOutputSchema(tool) !== undefined && {
                outputSchema: listedOutputSchema(tool),
              }),
              ...(tool.annotations !== undefined && { annotations: tool.annotations }),
              ...(inspecting && {
                _meta: { [PRINCIPALS_META_KEY]: tool.principals ?? DEFAULT_PRINCIPALS },
              }),
            })),
        });
      case "tools/call": {
        if (inspecting) return rpcError(id, -32600, "An inspection token cannot call tools");
        const result = await callTool(ctx, caller, params);
        if (result === null) {
          const name = isRecord(params) ? params["name"] : undefined;
          return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        }
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}
