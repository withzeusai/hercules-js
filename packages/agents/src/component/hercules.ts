/**
 * Calls to the Hercules agents API. Every call is made from an action the
 * component schedules, with the app key the app passed in (a component cannot
 * read the app's environment variables).
 */
import { v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import {
  HERCULES_API_VERSION,
  isFinalStatus,
  readRun,
  readWireEvent,
  type Run,
  type WireEvent,
} from "./protocol.js";
import { STUCK_AFTER_MS, finishRun, runById, type RunOutcome } from "./store.js";
import {
  vApi,
  vCappedReason,
  vEndUser,
  vFinalRunStatus,
  vRunError,
  vRunStatus,
  vUsage,
  type ApiConfig,
} from "./validators.js";

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10 * 60 * 1000;
const MAX_START_ATTEMPTS = 8;
const MAX_CANCEL_ATTEMPTS = 6;
const MAX_DELETE_ATTEMPTS = 10;
/** A run nothing has been heard of for this long is given up on. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_PAGES = 20;

type HerculesResponse =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      status: number | null;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs: number | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export async function callHercules(
  config: ApiConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HerculesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        "hercules-version": HERCULES_API_VERSION,
        accept: "application/json",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      code: "unreachable",
      message: error instanceof Error ? error.message : "Hercules could not be reached.",
      retryable: true,
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (response.ok) return { ok: true, status: response.status, body: parsed };
  const problem = isRecord(parsed) ? parsed : {};
  const code = typeof problem["code"] === "string" ? problem["code"] : `http_${response.status}`;
  const message =
    typeof problem["detail"] === "string"
      ? problem["detail"]
      : typeof problem["title"] === "string"
        ? problem["title"]
        : `Hercules answered ${response.status}.`;
  return {
    ok: false,
    status: response.status,
    code,
    message,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  };
}

/** Full jitter on a delay that starts at a second and doubles up to ten minutes. */
export function retryDelayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter, MAX_RETRY_MS);
  const ceiling = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
  return Math.floor(Math.random() * ceiling);
}

function outcomeFromRun(run: Run): RunOutcome | null {
  if (!isFinalStatus(run.status)) return null;
  return {
    status: run.status,
    output: run.output,
    error:
      run.status === "failed"
        ? (run.error ?? { code: "run_failed", message: "The run failed." })
        : null,
    cappedReason: run.capped_reason,
    usage: run.usage,
  };
}

const vOutcome = v.object({
  status: vFinalRunStatus,
  output: v.union(v.string(), v.null()),
  error: v.union(vRunError, v.null()),
  cappedReason: v.union(vCappedReason, v.null()),
  usage: v.union(vUsage, v.null()),
});

function failed(code: string, message: string): RunOutcome {
  return {
    status: "failed",
    output: null,
    error: { code, message },
    cappedReason: null,
    usage: null,
  };
}

export const loadRun = internalQuery({
  args: { runId: v.string() },
  returns: v.union(
    v.object({
      runId: v.string(),
      threadId: v.string(),
      agentId: v.string(),
      status: vRunStatus,
      input: v.string(),
      context: v.optional(v.any()),
      pageActions: v.optional(v.array(v.string())),
      endUser: v.union(vEndUser, v.null()),
      accepted: v.boolean(),
      cancelRequested: v.boolean(),
      lastSeq: v.number(),
      lastEventAt: v.number(),
      createdAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { runId }) => {
    const run = await runById(ctx, runId);
    if (run === null) return null;
    return {
      runId: run.runId,
      threadId: run.threadId,
      agentId: run.agentId,
      status: run.status,
      input: run.input,
      ...(run.context !== undefined && { context: run.context as unknown }),
      ...(run.pageActions !== undefined && { pageActions: run.pageActions }),
      endUser: run.endUser,
      accepted: run.accepted,
      cancelRequested: run.cancelRequested,
      lastSeq: run.lastSeq,
      lastEventAt: run.lastEventAt,
      createdAt: run._creationTime,
    };
  },
});

/** Records that Hercules took the run, with its live stream. Says whether a cancel is waiting. */
export const recordAccepted = internalMutation({
  args: {
    runId: v.string(),
    status: v.union(vRunStatus, v.null()),
    live: v.union(v.object({ url: v.string(), token: v.string() }), v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run === null) return false;
    await ctx.db.patch(run._id, {
      accepted: true,
      ...(args.live !== null && { liveUrl: args.live.url, liveToken: args.live.token }),
      ...(run.status === "queued" && args.status === "running" && { status: "running" as const }),
    });
    return run.cancelRequested && !isFinalStatus(run.status);
  },
});

export const endRun = internalMutation({
  args: { runId: v.string(), outcome: vOutcome },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run !== null) await finishRun(ctx, run, args.outcome);
    return null;
  },
});

/** Sends a run to Hercules, retrying what may pass. The same run id makes a retry safe. */
export const startRun = internalAction({
  args: { runId: v.string(), api: vApi, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.hercules.loadRun, { runId: args.runId });
    if (run === null || run.accepted || isFinalStatus(run.status)) return null;
    if (run.cancelRequested) {
      await ctx.runMutation(internal.hercules.endRun, {
        runId: run.runId,
        outcome: {
          status: "cancelled",
          output: null,
          error: null,
          cappedReason: null,
          usage: null,
        },
      });
      return null;
    }

    const response = await callHercules(
      args.api,
      "POST",
      `/v1/agents/${encodeURIComponent(run.agentId)}/runs`,
      {
        run_id: run.runId,
        thread_id: run.threadId,
        ...(run.endUser !== null && {
          end_user:
            "tokenIdentifier" in run.endUser
              ? { token_identifier: run.endUser.tokenIdentifier }
              : { anonymous_id: run.endUser.anonymousId },
        }),
        input: [{ type: "text", text: run.input }],
        ...(run.context !== undefined && { context: run.context }),
        ...(run.pageActions !== undefined && { page_actions: run.pageActions }),
      },
    );

    if (response.ok) {
      const body = isRecord(response.body) ? response.body : {};
      const live = isRecord(body["live"]) ? body["live"] : null;
      const started = readRun(body["run"]);
      const cancelWaiting = await ctx.runMutation(internal.hercules.recordAccepted, {
        runId: run.runId,
        status: started?.status ?? null,
        live:
          live !== null && typeof live["url"] === "string" && typeof live["token"] === "string"
            ? { url: live["url"], token: live["token"] }
            : null,
      });
      if (cancelWaiting) {
        await ctx.scheduler.runAfter(0, internal.hercules.cancelRun, {
          runId: run.runId,
          api: args.api,
          attempt: 0,
        });
      }
      return null;
    }

    if (response.retryable && args.attempt + 1 < MAX_START_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        retryDelayMs(args.attempt, response.retryAfterMs),
        internal.hercules.startRun,
        { ...args, attempt: args.attempt + 1 },
      );
      return null;
    }
    console.error(
      `Hercules refused run ${run.runId}: ${response.status ?? "network"} ${response.code}`,
    );
    await ctx.runMutation(internal.hercules.endRun, {
      runId: run.runId,
      outcome: response.retryable
        ? failed("run_failed", "Hercules could not be reached to start the run.")
        : failed(response.code, response.message),
    });
    return null;
  },
});

/** Records a run as Hercules reports it, ending it here if it ended there. */
export const recordRun = internalMutation({
  args: { runId: v.string(), outcome: v.union(vOutcome, v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run !== null && args.outcome !== null) await finishRun(ctx, run, args.outcome);
    return null;
  },
});

export const cancelRun = internalAction({
  args: { runId: v.string(), api: vApi, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const response = await callHercules(
      args.api,
      "POST",
      `/v1/agents/runs/${encodeURIComponent(args.runId)}/cancel`,
    );
    if (response.ok) {
      const run = readRun(response.body);
      if (run !== null) {
        await ctx.runMutation(internal.hercules.recordRun, {
          runId: args.runId,
          outcome: outcomeFromRun(run),
        });
      }
      return null;
    }
    if (response.retryable && args.attempt + 1 < MAX_CANCEL_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        retryDelayMs(args.attempt, response.retryAfterMs),
        internal.hercules.cancelRun,
        { ...args, attempt: args.attempt + 1 },
      );
      return null;
    }
    console.error(`Hercules did not cancel run ${args.runId}: ${response.code}`);
    return null;
  },
});

export const deleteThread = internalAction({
  args: { threadId: v.string(), api: vApi, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const response = await callHercules(
      args.api,
      "DELETE",
      `/v1/agents/threads/${encodeURIComponent(args.threadId)}`,
    );
    // A thread Hercules never saw is already gone there.
    if (response.ok || response.status === 404) return null;
    if (response.retryable && args.attempt + 1 < MAX_DELETE_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        retryDelayMs(args.attempt, response.retryAfterMs),
        internal.hercules.deleteThread,
        { ...args, attempt: args.attempt + 1 },
      );
      return null;
    }
    console.error(`Hercules did not delete thread ${args.threadId}: ${response.code}`);
    return null;
  },
});

/**
 * The stuck-run check. While a run is going it runs every few minutes; when
 * nothing has been delivered for `STUCK_AFTER_MS` it reads the run and its
 * events from Hercules and applies what delivery missed.
 */
export const checkRun = internalAction({
  args: { runId: v.string(), api: vApi },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.hercules.loadRun, { runId: args.runId });
    if (run === null || isFinalStatus(run.status)) return null;
    const now = Date.now();
    const quietFor = now - run.lastEventAt;
    // Not taken yet: the start call is still trying and ends the run if it gives up.
    if (!run.accepted || quietFor < STUCK_AFTER_MS) {
      await ctx.scheduler.runAfter(
        run.accepted ? STUCK_AFTER_MS - quietFor : STUCK_AFTER_MS,
        internal.hercules.checkRun,
        args,
      );
      return null;
    }

    let after = run.lastSeq;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const response = await callHercules(
        args.api,
        "GET",
        `/v1/agents/runs/${encodeURIComponent(run.runId)}/events?after=${after}&limit=100`,
      );
      if (!response.ok || !isRecord(response.body)) break;
      const data = Array.isArray(response.body["data"]) ? response.body["data"] : [];
      const events = data
        .map(readWireEvent)
        .filter((event): event is WireEvent => event !== null && event.runId === run.runId);
      if (events.length > 0) {
        await ctx.runMutation(api.events.apply, { events });
        after = Math.max(after, ...events.map((event) => event.seq));
      }
      if (response.body["has_more"] !== true || events.length === 0) break;
    }

    const response = await callHercules(
      args.api,
      "GET",
      `/v1/agents/runs/${encodeURIComponent(run.runId)}`,
    );
    if (response.ok) {
      const current = readRun(response.body);
      const outcome = current === null ? null : outcomeFromRun(current);
      if (outcome !== null) {
        await ctx.runMutation(internal.hercules.recordRun, { runId: run.runId, outcome });
        return null;
      }
    } else if (response.status === 404) {
      await ctx.runMutation(internal.hercules.endRun, {
        runId: run.runId,
        outcome: failed("run_failed", "Hercules has no record of this run."),
      });
      return null;
    } else if (now - run.createdAt > GIVE_UP_AFTER_MS) {
      await ctx.runMutation(internal.hercules.endRun, {
        runId: run.runId,
        outcome: failed("run_failed", "Nothing was heard from Hercules about this run for a day."),
      });
      return null;
    }
    await ctx.scheduler.runAfter(STUCK_AFTER_MS, internal.hercules.checkRun, args);
    return null;
  },
});
