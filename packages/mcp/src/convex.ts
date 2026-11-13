/**
 * The Convex adapter: declare tools with Convex validators and serve them
 * from the app's HTTP router.
 *
 * ```ts
 * // convex/mcp.ts
 * import { defineMcpServer, tool } from "@usehercules/mcp/convex";
 *
 * export const mcp = defineMcpServer({
 *   tools: {
 *     create_task: tool({
 *       description: "Creates a task for the signed-in user.",
 *       args: { title: v.string() },
 *       handler: (ctx, args, caller) =>
 *         ctx.runMutation(internal.tasks.createFor, {
 *           tokenIdentifier: caller.tokenIdentifier,
 *           title: args.title,
 *         }),
 *     }),
 *   },
 * });
 *
 * // convex/http.ts
 * mcp.registerRoutes(http);
 * ```
 *
 * A tool handler has no `ctx.auth`: the bearer token is checked here, not by
 * Convex, so it is worth nothing on the app's other functions. The verified
 * caller is the handler's third argument, and handlers pass it to internal
 * functions explicitly.
 */
import {
  httpActionGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import {
  ConvexError,
  type GenericValidator,
  type Infer,
  type ObjectType,
  type PropertyValidators,
} from "convex/values";
import { createTokenVerifier } from "./jwt";
import {
  createMcpHandler,
  McpToolError,
  type JsonSchema,
  type McpCaller,
  type McpPrincipal,
  type McpTool,
  type McpToolAnnotations,
} from "./server";

export { McpToolError, type McpCaller, type McpPrincipal, type McpToolAnnotations } from "./server";

declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * What a tool handler may do: call the app's own functions. Nothing else from
 * Convex's action context is offered, so a tool written here ports to another
 * backend's adapter unchanged.
 */
export type McpToolCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

type Awaitable<T> = T | Promise<T>;

export interface ToolDefinition<
  Args extends PropertyValidators,
  Returns extends GenericValidator | undefined,
  Principal extends McpPrincipal,
> {
  /** What the tool does and when to use it, written for the calling model. */
  description: string;
  args: Args;
  /**
   * What the tool returns. Enforced: object fields it does not name are
   * removed before the result leaves the app, so it is also the list of
   * fields an assistant may see.
   */
  returns?: Returns;
  annotations?: McpToolAnnotations;
  /**
   * Who may call the tool. Defaults to `["user"]`, signed-in end users only.
   * Add `"agent"` for a tool a Hercules agent may run with no end user.
   */
  principals?: readonly Principal[];
  handler: (
    ctx: McpToolCtx,
    args: ObjectType<Args>,
    caller: Extract<McpCaller, { principal: Principal }>,
  ) => Awaitable<Returns extends GenericValidator ? Infer<Returns> : unknown>;
}

/** A tool ready to be listed in `defineMcpServer({ tools })`. */
export type ConvexMcpTool = McpTool<McpToolCtx>;

type Direction = "input" | "output";

/** A value that does not fit a validator. `path` reads like `args.items[2].title`. */
class ShapeMismatch extends Error {
  constructor(path: string, expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = "ShapeMismatch";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const INT64_PATTERN = /^-?[0-9]+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function base64ToBuffer(value: string): ArrayBuffer | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

/** JSON Schema for a Convex validator, as MCP clients read a tool's input and output. */
export function validatorToJsonSchema(validator: GenericValidator): JsonSchema {
  switch (validator.kind) {
    case "string":
      return { type: "string" };
    case "float64":
      return { type: "number" };
    case "int64":
      return {
        type: "string",
        pattern: INT64_PATTERN.source,
        description: "A 64-bit integer, written as a decimal string",
      };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "bytes":
      return { type: "string", contentEncoding: "base64" };
    case "id":
      return {
        type: "string",
        description: `The id of a document in the "${validator.tableName}" table`,
      };
    case "literal":
      return {
        const: typeof validator.value === "bigint" ? validator.value.toString() : validator.value,
      };
    case "array":
      return { type: "array", items: validatorToJsonSchema(validator.element) };
    case "record":
      return { type: "object", additionalProperties: validatorToJsonSchema(validator.value) };
    case "object":
      return fieldsToJsonSchema(validator.fields);
    case "union":
      return { anyOf: validator.members.map(validatorToJsonSchema) };
    default:
      return {};
  }
}

function fieldsToJsonSchema(fields: PropertyValidators): JsonSchema {
  const entries = Object.entries(fields);
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([name, field]) => [name, validatorToJsonSchema(field)]),
    ),
    required: entries.filter(([, field]) => field.isOptional !== "optional").map(([name]) => name),
    additionalProperties: false,
  };
}

function fitFields(
  fields: PropertyValidators,
  value: unknown,
  path: string,
  direction: Direction,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ShapeMismatch(path, "an object");
  if (direction === "input") {
    const unknownField = Object.keys(value).find((name) => !Object.hasOwn(fields, name));
    if (unknownField !== undefined) {
      throw new ShapeMismatch(`${path}.${unknownField}`, "no such field");
    }
  }
  const fitted: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const entry = value[name];
    if (entry === undefined) {
      if (field.isOptional === "optional") continue;
      throw new ShapeMismatch(`${path}.${name}`, "a value");
    }
    fitted[name] = fit(field, entry, `${path}.${name}`, direction);
  }
  return fitted;
}

/**
 * Checks `value` against a validator and returns it in the form the receiver
 * needs. Inbound, JSON becomes Convex values (`"12"` to `12n`, base64 to
 * bytes) and unknown object fields are refused. Outbound, unknown object
 * fields are dropped, which is what makes `returns` an allowlist.
 */
function fit(
  validator: GenericValidator,
  value: unknown,
  path: string,
  direction: Direction,
): unknown {
  switch (validator.kind) {
    case "string":
    case "id":
      if (typeof value !== "string") throw new ShapeMismatch(path, "a string");
      return value;
    case "float64":
      if (typeof value !== "number") throw new ShapeMismatch(path, "a number");
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ShapeMismatch(path, "true or false");
      return value;
    case "null":
      if (value !== null) throw new ShapeMismatch(path, "null");
      return value;
    case "int64": {
      if (direction === "output") {
        if (typeof value !== "bigint") throw new ShapeMismatch(path, "a bigint");
        return value;
      }
      if (typeof value !== "string" || !INT64_PATTERN.test(value)) {
        throw new ShapeMismatch(path, "an integer written as a decimal string");
      }
      const parsed = BigInt(value);
      if (parsed < INT64_MIN || parsed > INT64_MAX) {
        throw new ShapeMismatch(path, "an integer that fits in 64 bits");
      }
      return parsed;
    }
    case "bytes": {
      if (direction === "output") {
        if (!(value instanceof ArrayBuffer)) throw new ShapeMismatch(path, "an ArrayBuffer");
        return value;
      }
      const buffer = typeof value === "string" ? base64ToBuffer(value) : null;
      if (buffer === null) throw new ShapeMismatch(path, "base64 text");
      return buffer;
    }
    case "literal": {
      const literal: unknown = validator.value;
      const matches =
        typeof literal === "bigint" && direction === "input"
          ? value === literal.toString()
          : value === literal;
      if (!matches) throw new ShapeMismatch(path, JSON.stringify(String(literal)));
      return literal;
    }
    case "array":
      if (!Array.isArray(value)) throw new ShapeMismatch(path, "an array");
      return value.map((entry, index) =>
        fit(validator.element, entry, `${path}[${index}]`, direction),
      );
    case "record": {
      if (!isPlainObject(value)) throw new ShapeMismatch(path, "an object");
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          fit(validator.value, entry, `${path}.${key}`, direction),
        ]),
      );
    }
    case "object":
      return fitFields(validator.fields, value, path, direction);
    case "union": {
      for (const member of validator.members) {
        try {
          return fit(member, value, path, direction);
        } catch (error) {
          if (!(error instanceof ShapeMismatch)) throw error;
        }
      }
      throw new ShapeMismatch(path, "one of the allowed shapes");
    }
    case "any":
      return value;
    default:
      throw new ShapeMismatch(path, "a supported type");
  }
}

/** Declares one tool. The handler's `args` and `caller` are typed from the definition. */
export function tool<
  Args extends PropertyValidators,
  Returns extends GenericValidator | undefined = undefined,
  Principal extends McpPrincipal = "user",
>(definition: ToolDefinition<Args, Returns, Principal>): ConvexMcpTool {
  const returns = definition.returns;
  return {
    description: definition.description,
    inputSchema: fieldsToJsonSchema(definition.args),
    ...(returns !== undefined && { outputSchema: validatorToJsonSchema(returns) }),
    ...(definition.annotations !== undefined && { annotations: definition.annotations }),
    ...(definition.principals !== undefined && { principals: definition.principals }),
    parseArgs(raw) {
      try {
        return fitFields(definition.args, raw, "args", "input");
      } catch (error) {
        // The model wrote these arguments, so it gets to read what was wrong with them.
        if (error instanceof ShapeMismatch)
          throw new McpToolError(`Invalid arguments. ${error.message}`);
        throw error;
      }
    },
    ...(returns !== undefined && {
      // A mismatch here is the app's bug, not the model's: it surfaces as a
      // generic failure and the detail goes to the app's logs.
      shapeResult: (value: unknown) => fit(returns, value, "result", "output"),
    }),
    handler: definition.handler as ConvexMcpTool["handler"],
  };
}

export interface McpServerDefinition {
  /**
   * The server's name. Leave it out for an app with one server. Name each
   * server when the app splits its tools by data or risk (`support`, `billing`).
   */
  name?: string;
  /** Where the server is routed. Defaults to `/mcp`, or `/mcp/<name>` for a named server. */
  path?: string;
  /** Guidance for the calling model on how to use this server's tools. */
  instructions?: string;
  tools: Readonly<Record<string, ConvexMcpTool>>;
  /** The app's Hercules Auth URL. Defaults to the `HERCULES_OIDC_AUTHORITY` environment variable. */
  issuer?: string;
  /**
   * The URLs this server is reached at; a token must be issued for one of
   * them. Defaults to this deployment's own URL for the server
   * (`CONVEX_SITE_URL` plus the path).
   */
  audiences?: readonly string[];
}

export interface DefinedMcpServer {
  name: string;
  path: string;
  /** Routes the server on the app's HTTP router. Call it once in `convex/http.ts`. */
  registerRoutes(http: HttpRouter): void;
  /** Answers one MCP request. `registerRoutes` uses it; tests can call it directly. */
  handle(ctx: McpToolCtx, request: Request): Promise<Response>;
}

const DEFAULT_SERVER_NAME = "default";
const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function env(name: string): string | undefined {
  const value = typeof process === "undefined" ? undefined : process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function describeConvexError(error: unknown): string | null {
  // `ConvexError` is how an app's functions tell a caller what went wrong.
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  console.error("MCP tool failed", error);
  return null;
}

/** Declares an MCP server over the app's tools. Export it and route it from `convex/http.ts`. */
export function defineMcpServer(definition: McpServerDefinition): DefinedMcpServer {
  const name = definition.name ?? DEFAULT_SERVER_NAME;
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`MCP server name "${name}" must be lowercase letters, digits and dashes`);
  }
  for (const toolName of Object.keys(definition.tools)) {
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      throw new Error(`MCP tool name "${toolName}" must be letters, digits, "_" and "-"`);
    }
  }
  const path = definition.path ?? (definition.name === undefined ? "/mcp" : `/mcp/${name}`);

  let handler: ((request: Request, ctx: McpToolCtx) => Promise<Response>) | null = null;

  // Built on the first request, not at import: environment variables are read
  // when the function runs, and the handler holds the key cache.
  function resolveHandler() {
    if (handler !== null) return handler;
    const issuer = definition.issuer ?? env("HERCULES_OIDC_AUTHORITY");
    const siteUrl = env("CONVEX_SITE_URL");
    const audiences =
      definition.audiences ??
      (siteUrl === undefined ? [] : [`${siteUrl.replace(/\/+$/, "")}${path}`]);
    if (issuer === undefined || audiences.length === 0) return null;
    handler = createMcpHandler<McpToolCtx>({
      name,
      tools: definition.tools,
      verifier: createTokenVerifier({ issuer, audiences }),
      describeError: describeConvexError,
      ...(definition.instructions !== undefined && { instructions: definition.instructions }),
    });
    return handler;
  }

  async function handle(ctx: McpToolCtx, request: Request): Promise<Response> {
    const resolved = resolveHandler();
    if (resolved === null) {
      console.error(
        "MCP server is not configured: HERCULES_OIDC_AUTHORITY or CONVEX_SITE_URL is unset",
      );
      return new Response(JSON.stringify({ error: "not_configured" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    // Only the three calls, so nothing else on Convex's context can be reached from a tool.
    const toolCtx: McpToolCtx = {
      runQuery: ctx.runQuery,
      runMutation: ctx.runMutation,
      runAction: ctx.runAction,
    };
    return resolved(request, toolCtx);
  }

  return {
    name,
    path,
    handle,
    registerRoutes(http) {
      const action = httpActionGeneric((ctx, request) => handle(ctx, request));
      // GET is routed too, so a client probing for an event stream reads 405, not a 404.
      http.route({ path, method: "POST", handler: action });
      http.route({ path, method: "GET", handler: action });
    },
  };
}
