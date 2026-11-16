/**
 * `HerculesAgents`: a Hercules agent in a Convex app, backed by the
 * `herculesAgents` component. It runs in the app's own functions, so it can
 * read `ctx.auth` and the app's environment, and passes the component what
 * it needs explicitly.
 */
import {
  createFunctionHandle,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
  type Auth,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { ComponentApi } from "./component/_generated/component";
import {
  DEFAULT_API_URL,
  EVENTS_PATH,
  isSafeApiUrl,
  readWireEvent,
  type WireEvent,
} from "./component/protocol";
import { ownerOf } from "./component/store";
import { vThread, type EndUser, type RunFinished } from "./component/validators";
import {
  bearerTokenOf,
  createTokenVerifier,
  deploymentOrigins,
  type TokenFailure,
  type TokenVerifier,
} from "./jwt";

declare const process: { env: Record<string, string | undefined> } | undefined;

export type { RunFinished } from "./component/validators";
export { vRunFinished as runFinishedValidator } from "./component/validators";

/** The thread `readThread` returns: what the component's `threads.read` answers. */
export type AgentThread = NonNullable<ComponentApi["threads"]["read"]["_returnType"]>;
export type ThreadMessage = AgentThread["messages"][number];
export type ActiveRun = NonNullable<AgentThread["activeRun"]>;
export type PendingPageAction = AgentThread["pageActions"][number];
/** What `readThreadDetails` returns: the thread as stored, with its tool calls and their results. */
export type AgentThreadDetails = NonNullable<ComponentApi["threads"]["readDetails"]["_returnType"]>;
export type StoredToolCall = AgentThreadDetails["toolCalls"][number];

/**
 * The `code` of a `ConvexError` from `send` and the other methods, for the
 * page to show or act on. `data` is `{ code, message, retryAfterSeconds? }`.
 */
export type AgentErrorCode =
  | "sign_in_required"
  | "not_found"
  | "thread_busy"
  | "end_user_rate_limited"
  | "message_too_long"
  | "invalid_request";

export interface AgentErrorData {
  code: AgentErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

type RunFinishedHandler =
  | FunctionReference<"mutation", "internal" | "public", RunFinished>
  | FunctionReference<"action", "internal" | "public", RunFinished>;

export interface HerculesAgentsOptions {
  /** The agent's id: a ULID, such as `01JDX5ZQ8W3J2K6M9N4P7R1S0T`. */
  agentId: string;
  /**
   * Called once a run is over, after its last write, with `RunFinished`.
   * Usually an `internalMutation`; take `runFinishedValidator.fields` as args.
   */
  onRunFinished?: RunFinishedHandler;
  limits?: {
    /** Runs one signed-in user may start in an hour. No limit when left out. */
    runsPerUserPerHour?: number;
  };
  /**
   * Lets the page see what the agent's tools did in full: the results of the
   * app's own tools, and the names and summaries of Hercules's built-in and
   * connector tools. Defaults to false: a page then sees every Hercules tool
   * call as "tool" with the summary "Used a tool" (or "Couldn't use a tool"),
   * and no tool results, in the thread and in the run's live stream alike.
   * The app's backend reads the full record either way, with
   * `readThreadDetails`.
   */
  exposeToolDetails?: boolean;
  /** The page actions every run may call, by name. They must be declared on the agent. */
  pageActions?: readonly string[];
  /** Defaults to the `HERCULES_API_KEY` environment variable. Never send it to a browser. */
  apiKey?: string;
  /**
   * Defaults to `HERCULES_API_URL`, then `https://api.hercules.app`. Must be
   * https, or http to localhost: the app key is sent to it.
   */
  apiUrl?: string;
  /** The app's Hercules Auth URL. Defaults to `HERCULES_OIDC_AUTHORITY`. */
  issuer?: string;
}

type AuthCtx = { auth: Auth };
// The action context's signatures, which the query and mutation contexts' extend.
type RunQueryCtx = { runQuery: GenericActionCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = { runMutation: GenericActionCtx<GenericDataModel>["runMutation"] };

export interface SendArgs {
  /** Leave out to start a new thread. */
  threadId?: string;
  text: string;
  /** Named JSON values about the page, appended to the input. */
  context?: Record<string, unknown>;
  /** Page actions for this run, in place of the ones in the options. */
  pageActions?: readonly string[];
}

export interface ThreadArgs {
  threadId: string;
}

/** The deliveries Hercules sends hold up to 1 MiB; anything far larger is not one. */
const MAX_EVENTS_BODY_BYTES = 4 * 1024 * 1024;
/** Routers that already have the events route: one serves every agent in the app. */
const routedRouters = new WeakSet<HttpRouter>();

function env(name: string): string | undefined {
  const value = typeof process === "undefined" ? undefined : process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function fail(code: AgentErrorCode, message: string, retryAfterSeconds?: number): never {
  const data: AgentErrorData = {
    code,
    message,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  };
  throw new ConvexError(data as unknown as Record<string, string | number>);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function tokenRejection(reason: TokenFailure): Response {
  if (reason === "keys_unavailable") {
    return json(503, { error: "temporarily_unavailable" }, { "retry-after": "5" });
  }
  return json(401, { error: "unauthorized", reason }, { "www-authenticate": "Bearer" });
}

/**
 * One Hercules agent in a Convex app. Build it once at module scope:
 *
 * ```ts
 * // convex/agent.ts
 * export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
 *   agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
 *   onRunFinished: internal.orders.onAgentRunFinished,
 *   limits: { runsPerUserPerHour: 20 },
 * });
 * export const { send, thread, cancel, claimPageAction, deleteThread } = support.api();
 *
 * // convex/http.ts
 * support.registerRoutes(http);
 * ```
 *
 * Keep the `: HerculesAgents` annotation. `internal` is typed from every
 * module's exports, this one's included, so without it TypeScript cannot
 * infer `support` from an initializer that names `internal` (TS7022).
 */
export class HerculesAgents {
  readonly component: ComponentApi;
  readonly options: HerculesAgentsOptions;
  private verifier: TokenVerifier | null = null;

  constructor(component: ComponentApi, options: HerculesAgentsOptions) {
    this.component = component;
    this.options = options;
  }

  get agentId(): string {
    return this.options.agentId;
  }

  private apiConfig() {
    const key = this.options.apiKey ?? env("HERCULES_API_KEY");
    if (key === undefined) {
      throw new Error("HERCULES_API_KEY is not set, so the agent cannot be called");
    }
    const url = this.options.apiUrl ?? env("HERCULES_API_URL") ?? DEFAULT_API_URL;
    if (!isSafeApiUrl(url)) {
      throw new Error(
        "HERCULES_API_URL must be an https URL (or http://localhost): the app key is sent to it",
      );
    }
    return { key, url };
  }

  /** The signed-in user, or null. */
  private async endUserOf(ctx: AuthCtx): Promise<EndUser | null> {
    const identity = await ctx.auth.getUserIdentity();
    return identity === null ? null : { tokenIdentifier: identity.tokenIdentifier };
  }

  private async ownerFor(ctx: AuthCtx): Promise<string | null> {
    const endUser = await this.endUserOf(ctx);
    return endUser === null ? null : ownerOf(endUser);
  }

  private async start(
    ctx: RunMutationCtx,
    endUser: EndUser | null,
    args: SendArgs,
  ): Promise<{ threadId: string; runId: string }> {
    const onRunFinished =
      this.options.onRunFinished === undefined
        ? undefined
        : await createFunctionHandle(this.options.onRunFinished);
    const pageActions = args.pageActions ?? this.options.pageActions;
    const runsPerHour = endUser === null ? undefined : this.options.limits?.runsPerUserPerHour;
    const result = await ctx.runMutation(this.component.threads.send, {
      agentId: this.options.agentId,
      endUser,
      text: args.text,
      api: this.apiConfig(),
      ...(args.threadId !== undefined && { threadId: args.threadId }),
      ...(args.context !== undefined && { context: args.context }),
      ...(pageActions !== undefined && { pageActions: [...pageActions] }),
      ...(runsPerHour !== undefined && { runsPerHour }),
      ...(onRunFinished !== undefined && { onRunFinished }),
      ...(this.options.exposeToolDetails === true && { exposeToolDetails: true }),
    });
    if (!result.ok) fail(result.code as AgentErrorCode, result.message, result.retryAfterSeconds);
    return { threadId: result.threadId, runId: result.runId };
  }

  /**
   * Sends the caller's message and starts a run, in a mutation. The caller
   * is the signed-in user (`ctx.auth`): without one it throws
   * `sign_in_required`. Checks the hourly limit in the same transaction.
   * Throws a `ConvexError` with `AgentErrorData`.
   */
  async send(ctx: AuthCtx & RunMutationCtx, args: SendArgs) {
    const endUser = await this.endUserOf(ctx);
    if (endUser === null) fail("sign_in_required", "Sign in to talk to the agent.");
    return await this.start(ctx, endUser, args);
  }

  /**
   * Starts a run as the app's own job, for no end user: from a scheduled
   * function, say. Its thread is the app's and no user can read it.
   */
  async run(ctx: RunMutationCtx, args: SendArgs) {
    return await this.start(ctx, null, args);
  }

  /**
   * The caller's thread, in a query: messages, the run that is going with
   * its live stream, and page actions waiting for a tab. Null for a thread
   * that does not exist or is someone else's, and for a caller who is not
   * signed in.
   *
   * It is what a page shows, so without `exposeToolDetails` its Hercules
   * tool calls are named "tool", and no tool call carries a result.
   *
   * It holds the thread's newest messages: 100 unless `limit` says
   * otherwise, at most 200, and fewer when they come to more than about
   * 4 MiB. `hasMore` says there are older ones. `pageActions` lists the page
   * actions no tab has run, `pending` or `expired`. Only this agent's
   * threads are read: another agent's thread is null here.
   */
  async readThread(
    ctx: AuthCtx & RunQueryCtx,
    args: ThreadArgs & { limit?: number },
  ): Promise<AgentThread | null> {
    const owner = await this.ownerFor(ctx);
    if (owner === null) return null;
    return await ctx.runQuery(this.component.threads.read, {
      threadId: args.threadId,
      agentId: this.options.agentId,
      owner,
      ...(args.limit !== undefined && { limit: args.limit }),
      ...(this.options.exposeToolDetails === true && { exposeToolDetails: true }),
    });
  }

  /**
   * One of this agent's threads as the component stores it, for the app's
   * own backend: every tool call under its own name, and `toolCalls` with
   * the results of the app's tools. Null for a thread that does not exist.
   *
   * It does not read `ctx.auth` and answers for any user's thread, so call it
   * from an internal function, or check who is asking first. Do not return
   * it to a page: that is what `exposeToolDetails` is for.
   */
  async readThreadDetails(
    ctx: RunQueryCtx,
    args: ThreadArgs & { limit?: number },
  ): Promise<AgentThreadDetails | null> {
    return await ctx.runQuery(this.component.threads.readDetails, {
      threadId: args.threadId,
      agentId: this.options.agentId,
      ...(args.limit !== undefined && { limit: args.limit }),
    });
  }

  /** Stops the run going on the caller's thread. True when there was one. */
  async cancel(ctx: AuthCtx & RunMutationCtx, args: ThreadArgs): Promise<boolean> {
    const owner = await this.ownerFor(ctx);
    if (owner === null) return false;
    return await ctx.runMutation(this.component.threads.cancel, {
      threadId: args.threadId,
      agentId: this.options.agentId,
      owner,
      api: this.apiConfig(),
    });
  }

  /** Deletes the caller's thread, here and at Hercules. Irreversible. */
  async deleteThread(ctx: AuthCtx & RunMutationCtx, args: ThreadArgs): Promise<boolean> {
    const owner = await this.ownerFor(ctx);
    if (owner === null) return false;
    return await ctx.runMutation(this.component.threads.remove, {
      threadId: args.threadId,
      agentId: this.options.agentId,
      owner,
      api: this.apiConfig(),
    });
  }

  /**
   * Takes a page action for the calling tab to run. True for the first tab
   * that asks; every other gets false and must not run it. False too for a
   * tool call the run did not make, and for a page action whose event is two
   * minutes old or more by the server's clock: that one is then listed on
   * the thread with `status: "expired"`.
   */
  async claimPageAction(
    ctx: AuthCtx & RunMutationCtx,
    args: ThreadArgs & { runId: string; toolCallId: string },
  ): Promise<boolean> {
    const owner = await this.ownerFor(ctx);
    if (owner === null) return false;
    return await ctx.runMutation(this.component.threads.claimPageAction, {
      threadId: args.threadId,
      agentId: this.options.agentId,
      runId: args.runId,
      toolCallId: args.toolCallId,
      owner,
    });
  }

  /**
   * The app functions a page needs, ready to export from `convex/agent.ts`:
   * `send`, `thread`, `cancel`, `claimPageAction` and `deleteThread`.
   * `@usehercules/agents/react` and `/tanstack` call them by these names.
   */
  api() {
    return {
      send: mutationGeneric({
        args: {
          threadId: v.optional(v.string()),
          text: v.string(),
          context: v.optional(v.record(v.string(), v.any())),
        },
        returns: v.object({ threadId: v.string(), runId: v.string() }),
        handler: (ctx, args) => this.send(ctx, args),
      }),
      thread: queryGeneric({
        args: { threadId: v.string(), limit: v.optional(v.number()) },
        returns: v.union(vThread, v.null()),
        handler: (ctx, args) => this.readThread(ctx, args),
      }),
      cancel: mutationGeneric({
        args: { threadId: v.string() },
        returns: v.boolean(),
        handler: (ctx, args) => this.cancel(ctx, args),
      }),
      claimPageAction: mutationGeneric({
        args: { threadId: v.string(), runId: v.string(), toolCallId: v.string() },
        returns: v.boolean(),
        handler: (ctx, args) => this.claimPageAction(ctx, args),
      }),
      deleteThread: mutationGeneric({
        args: { threadId: v.string() },
        returns: v.boolean(),
        handler: (ctx, args) => this.deleteThread(ctx, args),
      }),
    };
  }

  private eventsVerifier(): TokenVerifier | null {
    if (this.verifier !== null) return this.verifier;
    const issuer = this.options.issuer ?? env("HERCULES_OIDC_AUTHORITY");
    // Hercules signs for the deployment's own `.convex.site` URL, which
    // `CONVEX_SITE_URL` is unless the app points it at a custom domain.
    const origins = deploymentOrigins(env("CONVEX_SITE_URL"), env("CONVEX_CLOUD_URL"));
    if (issuer === undefined || origins.length === 0) return null;
    this.verifier = createTokenVerifier({
      issuer,
      audiences: origins.map((origin) => `${origin}${EVENTS_PATH}`),
    });
    return this.verifier;
  }

  /**
   * Answers one delivery from Hercules: checks its token, then applies the
   * batch in one mutation. `registerRoutes` routes it; tests can call it.
   *
   * Hercules reads the status as a verdict, so each is chosen for what it
   * does there:
   *
   * - 2xx: applied. Events of a type this package does not know, and entries
   *   it cannot read, are skipped, so what Hercules adds later never stops a
   *   thread's delivery.
   * - 401, 403: only for a token that was checked and is not Hercules's for
   *   this route. Hercules takes either as the whole deployment refusing it
   *   and stops delivering for an hour.
   * - 503 with `Retry-After`: the issuer's keys cannot be fetched. That says
   *   nothing about the token.
   * - 500: the app's environment is not set, or one event could not be
   *   applied. Tried again, with backoff, for a day.
   * - 413: a batch of several events could not be applied. Hercules sends
   *   half of it, down to the one event that fails, which then gets a 500.
   * - 400: a body that is not `{ events: [...] }` at all.
   */
  async handleEvents(ctx: RunMutationCtx, request: Request, verifier?: TokenVerifier) {
    const tokens = verifier ?? this.eventsVerifier();
    if (tokens === null) {
      console.error(
        "Hercules agent events are not configured: HERCULES_OIDC_AUTHORITY or CONVEX_SITE_URL is unset",
      );
      return json(500, { error: "not_configured" });
    }
    const verified = await tokens.verify(bearerTokenOf(request));
    if (!verified.ok) return tokenRejection(verified.reason);
    // Only Hercules itself delivers events; a token for a user or an agent is not enough.
    if (verified.token.claims["hercules_principal"] !== "hercules") {
      return json(403, { error: "forbidden" });
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_EVENTS_BODY_BYTES) return json(413, { error: "request_too_large" });
    const text = await request.text();
    if (text.length > MAX_EVENTS_BODY_BYTES) return json(413, { error: "request_too_large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const raw =
      typeof body === "object" && body !== null && "events" in body
        ? (body as { events: unknown }).events
        : undefined;
    if (!Array.isArray(raw)) return json(400, { error: "invalid_request" });
    const events: WireEvent[] = [];
    // An entry without a run, a sequence number and a type cannot be placed.
    // It is skipped, not refused: a refusal would hold up the whole thread.
    let unreadable = 0;
    for (const entry of raw) {
      const event = readWireEvent(entry);
      if (event === null) unreadable++;
      else events.push(event);
    }
    if (events.length === 0) return json(200, { applied: 0, skipped: unreadable });
    try {
      const result = await ctx.runMutation(this.component.events.apply, { events });
      return json(200, { applied: result.applied, skipped: result.skipped + unreadable });
    } catch (error) {
      console.error("Applying Hercules agent events failed", error);
      // Several events: whatever went wrong (most often more than one Convex
      // transaction holds), half the batch may pass, and 413 asks for half.
      // No error text is read to decide. One event: nothing smaller to send,
      // and a 413 for it would shelve the thread, so it is a plain failure.
      if (events.length > 1) return json(413, { error: "batch_too_large" });
      return json(500, { error: "apply_failed" });
    }
  }

  /**
   * Routes `POST /hercules/agents/events`, where Hercules delivers runs'
   * events. Call it once in `convex/http.ts`; one route serves every agent.
   */
  registerRoutes(http: HttpRouter): void {
    if (routedRouters.has(http)) return;
    routedRouters.add(http);
    http.route({
      path: EVENTS_PATH,
      method: "POST",
      handler: httpActionGeneric((ctx, request) => this.handleEvents(ctx, request)),
    });
  }
}
