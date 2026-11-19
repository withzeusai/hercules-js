/**
 * Hercules agents in a Convex app. Two halves:
 *
 * - App tools: declare tools with Convex validators and serve them to agents
 *   from the app's HTTP router (`defineTools`, `tool`).
 * - Talking to an agent: `HerculesAgents` starts runs from the app's
 *   functions and keeps their threads in the `herculesAgents` component
 *   (`@usehercules/agents/convex.config`).
 *
 * ```ts
 * // convex/tools.ts
 * import { defineTools, tool } from "@usehercules/agents/convex";
 *
 * export const tools = defineTools({
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
 * tools.registerRoutes(http);
 * ```
 *
 * A tool handler has no `ctx.auth`: the bearer token is checked here, not by
 * Convex, so it is worth nothing on the app's other functions. The verified
 * caller is the handler's third argument, and handlers pass it to internal
 * functions explicitly.
 */
import type { GenericActionCtx, GenericDataModel, HttpRouter } from "convex/server";
import {
  type GenericValidator,
  type Infer,
  type ObjectType,
  type PropertyValidators,
} from "convex/values";
import { fieldsToJsonSchema, INT64_PATTERN, validatorToJsonSchema } from "./json-schema";
import {
  ToolError,
  type AgentOrigin,
  type KnownPrincipal,
  type ToolCaller,
  type McpTool,
  type ToolAnnotations,
} from "./server";
import { createToolServer, sealTool, type ConvexTool } from "./tool-server";

export {
  ToolError,
  type AgentOrigin,
  type ToolCaller,
  type ToolPrincipal,
  type ToolAnnotations,
} from "./server";

/**
 * What a tool handler may do: call the app's own functions. Nothing else from
 * Convex's action context is offered, so a tool written here ports to another
 * backend's adapter unchanged.
 */
export type ToolCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

type Awaitable<T> = T | Promise<T>;

export interface ToolDefinition<
  Args extends PropertyValidators,
  Returns extends GenericValidator | undefined,
  Principal extends KnownPrincipal,
> {
  /** What the tool does and when to use it, written for the calling model. */
  description: string;
  args: Args;
  /**
   * What the tool returns. Enforced: object fields it does not name are
   * removed before the result leaves the app, so it is also the list of
   * fields an assistant may see. A `v.object` or `v.record` is also listed
   * as the tool's MCP output schema and returned as structured content; any
   * other validator is enforced the same and returned as text.
   */
  returns?: Returns;
  annotations?: ToolAnnotations;
  /**
   * Who may call the tool. Defaults to `["user"]`, signed-in end users only.
   * Add `"agent"` for a tool a Hercules agent may run with no end user: from
   * the app's own job only, unless `agentOrigins` says otherwise.
   */
  principals?: readonly Principal[];
  /**
   * For a tool that lists `"agent"`: where a run with no end user may have
   * been started for the tool to take its call. Defaults to `["app"]`: only
   * the app's own job, a run its backend started with the app's key and no
   * end user (`HerculesAgents.run`).
   *
   * List more origins to take them too, such as
   * `["app", "schedule", "trigger"]`: see `AgentOrigin`. `"any"` takes every
   * call with no end user, wherever its run was started, one whose token
   * does not say among them. The handler reads which it was as
   * `caller.origin`.
   *
   * Setting it on a tool that does not list `"agent"` is an error, at
   * compile time and when the tools are declared.
   */
  agentOrigins?: "agent" extends Principal ? readonly AgentOrigin[] | "any" : never;
  handler: (
    ctx: ToolCtx,
    args: ObjectType<Args>,
    caller: Extract<ToolCaller, { principal: Principal }>,
  ) => Awaitable<Returns extends GenericValidator ? Infer<Returns> : unknown>;
}

export type { ConvexTool } from "./tool-server";

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

/**
 * Whether a validator's JSON Schema has `type: "object"` at its root, the
 * only kind MCP takes as a tool's output schema.
 */
function hasObjectRoot(validator: GenericValidator): boolean {
  return validator.kind === "object" || validator.kind === "record";
}

/** Declares one tool. The handler's `args` and `caller` are typed from the definition. */
export function tool<
  Args extends PropertyValidators,
  Returns extends GenericValidator | undefined = undefined,
  Principal extends KnownPrincipal = "user",
>(definition: ToolDefinition<Args, Returns, Principal>): ConvexTool {
  const returns = definition.returns;
  return sealTool({
    description: definition.description,
    inputSchema: fieldsToJsonSchema(definition.args),
    ...(returns !== undefined &&
      hasObjectRoot(returns) && { outputSchema: validatorToJsonSchema(returns) }),
    ...(definition.annotations !== undefined && { annotations: definition.annotations }),
    ...(definition.principals !== undefined && { principals: definition.principals }),
    ...(definition.agentOrigins !== undefined && { agentOrigins: definition.agentOrigins }),
    parseArgs(raw) {
      try {
        return fitFields(definition.args, raw, "args", "input");
      } catch (error) {
        // The model wrote these arguments, so it gets to read what was wrong with them.
        if (error instanceof ShapeMismatch)
          throw new ToolError(`Invalid arguments. ${error.message}`);
        throw error;
      }
    },
    ...(returns !== undefined && {
      // A mismatch here is the app's bug, not the model's: it surfaces as a
      // generic failure and the detail goes to the app's logs.
      shapeResult: (value: unknown) => fit(returns, value, "result", "output"),
    }),
    handler: definition.handler as McpTool<ToolCtx>["handler"],
  });
}

export interface ToolsDefinition {
  /**
   * The server's name. Leave it out for an app with one server. Name each
   * server when the app splits its tools by data or risk (`support`, `billing`).
   * It decides where the server is routed: `/mcp`, or `/mcp/<name>` for a
   * named server. Those are the only paths Hercules calls.
   */
  name?: string;
  /** Guidance for the calling model on how to use this server's tools. */
  instructions?: string;
  tools: Readonly<Record<string, ConvexTool>>;
  /** The app's Hercules Auth URL. Defaults to the `HERCULES_OIDC_AUTHORITY` environment variable. */
  issuer?: string;
  /**
   * The URLs this server is reached at; a token must be issued for one of
   * them. Defaults to this deployment's own URLs for the server: the path on
   * `CONVEX_SITE_URL`, and on the `.convex.site` origin that goes with
   * `CONVEX_CLOUD_URL`. Hercules signs for the deployment's `.convex.site`
   * URL, so the second keeps a deployment whose `CONVEX_SITE_URL` is a
   * custom domain working.
   */
  audiences?: readonly string[];
}

export interface DefinedTools {
  /** Routes the server on the app's HTTP router. Call it once in `convex/http.ts`. */
  registerRoutes(http: HttpRouter): void;
}

/**
 * Declares the app's tools, served as an MCP server. Export the result and
 * route it from `convex/http.ts`.
 */
export function defineTools(definition: ToolsDefinition): DefinedTools {
  const server = createToolServer(definition);
  return { registerRoutes: (http) => server.registerRoutes(http) };
}

export {
  HerculesAgents,
  runFinishedValidator,
  type ActiveRun,
  type AgentErrorCode,
  type AgentErrorData,
  type AgentThread,
  type AgentThreadDetails,
  type HerculesAgentsOptions,
  type PendingPageAction,
  type RunFinished,
  type SendArgs,
  type StoredToolCall,
  type ThreadArgs,
  type ThreadMessage,
} from "./agents";
export type { UnknownName } from "./api";
