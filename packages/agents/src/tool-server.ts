/**
 * One MCP server of a Convex app: the tools `defineTools` was given, routed
 * on the app's HTTP router and answered from an HTTP action. `defineTools`
 * in `./convex` hands the app only `registerRoutes`; the name, the path and
 * the request handler stay here, for the package and its tests. Not exported
 * from the package.
 */
import { httpActionGeneric, type HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import type { ToolCtx, ToolsDefinition } from "./convex";
import { createTokenVerifier, deploymentOrigins } from "./jwt";
import { checkToolAccess, createMcpHandler } from "./server";

declare const process: { env: Record<string, string | undefined> } | undefined;

export interface ToolServer {
  name: string;
  path: string;
  /** Routes the server on the app's HTTP router. */
  registerRoutes(http: HttpRouter): void;
  /** Answers one MCP request. `registerRoutes` uses it; tests call it directly. */
  handle(ctx: ToolCtx, request: Request): Promise<Response>;
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

/** Builds the server `defineTools` declares. Throws on a name or a tool that cannot be served. */
export function createToolServer(definition: ToolsDefinition): ToolServer {
  const name = definition.name ?? DEFAULT_SERVER_NAME;
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`MCP server name "${name}" must be lowercase letters, digits and dashes`);
  }
  for (const toolName of Object.keys(definition.tools)) {
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      throw new Error(`MCP tool name "${toolName}" must be letters, digits, "_" and "-"`);
    }
  }
  // When the module loads, so a mistake fails the deploy, not the first call.
  for (const [toolName, declared] of Object.entries(definition.tools)) {
    checkToolAccess(toolName, declared);
  }
  const path = definition.name === undefined ? "/mcp" : `/mcp/${name}`;

  let handler: ((request: Request, ctx: ToolCtx) => Promise<Response>) | null = null;

  // Built on the first request, not at import: environment variables are read
  // when the function runs, and the handler holds the key cache.
  function resolveHandler() {
    if (handler !== null) return handler;
    const issuer = definition.issuer ?? env("HERCULES_OIDC_AUTHORITY");
    const audiences =
      definition.audiences ??
      deploymentOrigins(env("CONVEX_SITE_URL"), env("CONVEX_CLOUD_URL")).map(
        (origin) => `${origin}${path}`,
      );
    if (issuer === undefined || audiences.length === 0) return null;
    handler = createMcpHandler<ToolCtx>({
      name,
      tools: definition.tools,
      verifier: createTokenVerifier({ issuer, audiences }),
      describeError: describeConvexError,
      ...(definition.instructions !== undefined && { instructions: definition.instructions }),
    });
    return handler;
  }

  async function handle(ctx: ToolCtx, request: Request): Promise<Response> {
    const resolved = resolveHandler();
    if (resolved === null) {
      // 500, which a caller tries again: the environment may only not be set yet.
      console.error(
        "MCP server is not configured: HERCULES_OIDC_AUTHORITY or CONVEX_SITE_URL is unset",
      );
      return new Response(JSON.stringify({ error: "not_configured" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    // Only the three calls, so nothing else on Convex's context can be reached from a tool.
    const toolCtx: ToolCtx = {
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
