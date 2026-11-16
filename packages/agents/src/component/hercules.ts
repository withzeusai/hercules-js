/**
 * Calls to the Hercules agents API. Every call is made from an action the
 * component schedules, with the app key the app passed in (a component cannot
 * read the app's environment variables).
 */
import { v, type Infer } from "convex/values";
import { api, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server.js";
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
/** A run that could not be settled for this long is given up on. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_PAGES = 20;
const EVENT_PAGE_SIZE = 100;
/**
 * Hercules holds a thread for a moment after a run ends, while the run's
 * workflow closes. A start refused as `thread_busy` is tried again for this long.
 */
const THREAD_BUSY_RETRY_MS = 60 * 1000;
const THREAD_BUSY_MAX_DELAY_MS = 5 * 1000;
/** How long past its due time a scheduled start call may still be running. */
const START_GRACE_MS = 60 * 1000;
/**
 * A run Hercules says it has no record of is failed only once it has said so
 * for this long: it also answers 404 while it cannot tell whether the API is
 * turned on for the caller.
 */
const MISSING_FINAL_AFTER_MS = 60 * 60 * 1000;
/** How soon the check comes back when a run has more events than one check reads. */
const MORE_EVENTS_DELAY_MS = 1_000;

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

/**
 * Whether a refusal may pass if the same request is sent again. Of the 429s
 * only `rate_limited` (too many requests just now) and one with no code (a
 * proxy's) may: `end_user_rate_limited` and `agent_daily_limit_reached` are
 * quotas, which stand for hours.
 */
function isRetryable(status: number, code: string | null): boolean {
  if (status === 429) return code === null || code === "rate_limited";
  return status === 408 || status >= 500;
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
  const code = typeof problem["code"] === "string" ? problem["code"] : null;
  const message =
    typeof problem["detail"] === "string"
      ? problem["detail"]
      : typeof problem["title"] === "string"
        ? problem["title"]
        : `Hercules answered ${response.status}.`;
  return {
    ok: false,
    status: response.status,
    code: code ?? `http_${response.status}`,
    message,
    retryable: isRetryable(response.status, code),
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

function failed(code: string, message: string, retryAfterSeconds?: number): RunOutcome {
  return {
    status: "failed",
    output: null,
    error: { code, message, ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) },
    cappedReason: null,
    usage: null,
  };
}

const CANCELLED: RunOutcome = {
  status: "cancelled",
  output: null,
  error: null,
  cappedReason: null,
  usage: null,
};

/** How a refused start ends the run: with Hercules's own code, and how long its limit lasts. */
function refused(response: Extract<HerculesResponse, { ok: false }>): RunOutcome {
  const { status } = response;
  if (status === null || status === 408 || status >= 500) {
    return failed("run_failed", "Hercules could not be reached to start the run.");
  }
  return failed(
    response.code,
    response.message,
    response.status === 429 && response.retryAfterMs !== null
      ? Math.ceil(response.retryAfterMs / 1000)
      : undefined,
  );
}

const vLoadedRun = v.object({
  runId: v.string(),
  threadId: v.string(),
  agentId: v.string(),
  status: vRunStatus,
  /** Null when the request row is gone: the run cannot be sent again. */
  request: v.union(
    v.object({
      input: v.string(),
      context: v.optional(v.any()),
      pageActions: v.optional(v.array(v.string())),
    }),
    v.null(),
  ),
  endUser: v.union(vEndUser, v.null()),
  exposeToolDetails: v.boolean(),
  accepted: v.boolean(),
  /** The run's live token is stored. */
  hasLive: v.boolean(),
  cancelRequested: v.boolean(),
  nextStartAt: v.union(v.number(), v.null()),
  missingSince: v.union(v.number(), v.null()),
  lastSeq: v.number(),
  lastEventAt: v.number(),
  createdAt: v.number(),
});
type LoadedRun = Infer<typeof vLoadedRun>;

export const loadRun = internalQuery({
  args: { runId: v.string() },
  returns: v.union(vLoadedRun, v.null()),
  handler: async (ctx, { runId }): Promise<LoadedRun | null> => {
    const run = await runById(ctx, runId);
    if (run === null) return null;
    const request = await ctx.db
      .query("run_requests")
      .withIndex("by_run_id", (q) => q.eq("runId", runId))
      .unique();
    return {
      runId: run.runId,
      threadId: run.threadId,
      agentId: run.agentId,
      status: run.status,
      request:
        request === null
          ? null
          : {
              input: request.input,
              ...(request.context !== undefined && { context: request.context as unknown }),
              ...(request.pageActions !== undefined && { pageActions: request.pageActions }),
            },
      endUser: run.endUser,
      exposeToolDetails: run.exposeToolDetails,
      accepted: run.accepted,
      hasLive: run.liveToken !== null,
      cancelRequested: run.cancelRequested,
      nextStartAt: run.nextStartAt,
      missingSince: run.missingSince,
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
    const going = !isFinalStatus(run.status);
    await ctx.db.patch(run._id, {
      accepted: true,
      nextStartAt: null,
      // A run that is over has no use for its stream.
      ...(going && args.live !== null && { liveUrl: args.live.url, liveToken: args.live.token }),
      ...(run.status === "queued" && args.status === "running" && { status: "running" as const }),
    });
    return run.cancelRequested && going;
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

/**
 * Ends a run Hercules would not take. Only a run it has not taken: a run
 * that a delivered event has since shown to be going is left alone, whatever
 * a later start call was answered.
 */
export const refuseRun = internalMutation({
  args: { runId: v.string(), outcome: vOutcome },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run !== null && !run.accepted) await finishRun(ctx, run, args.outcome);
    return null;
  },
});

/** Schedules the start call's next try, and notes when it is due so the check can tell a lost one. */
export const retryStart = internalMutation({
  args: {
    runId: v.string(),
    api: vApi,
    attempt: v.number(),
    busySince: v.optional(v.number()),
    delayMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { delayMs, ...next }) => {
    const run = await runById(ctx, next.runId);
    if (run === null || isFinalStatus(run.status)) return null;
    await ctx.db.patch(run._id, { nextStartAt: Date.now() + delayMs });
    await ctx.scheduler.runAfter(delayMs, internal.hercules.startRun, next);
    return null;
  },
});

/** Notes when Hercules first said it has no such run, or that it has it after all. */
export const noteMissing = internalMutation({
  args: { runId: v.string(), since: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run !== null) await ctx.db.patch(run._id, { missingSince: args.since });
    return null;
  },
});

/** Drops a run's live token: an hour after the run ended, Hercules no longer takes it. */
export const clearLive = internalMutation({
  args: { runId: v.string() },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await runById(ctx, runId);
    if (run !== null && (run.liveToken !== null || run.liveUrl !== null)) {
      await ctx.db.patch(run._id, { liveUrl: null, liveToken: null });
    }
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

/**
 * Applies events, in halves when the whole does not fit in one transaction.
 * False when some could not be applied: the caller leaves the run open.
 */
async function applyPulled(ctx: ActionCtx, events: WireEvent[]): Promise<boolean> {
  try {
    await ctx.runMutation(api.events.apply, { events });
    return true;
  } catch (error) {
    if (events.length === 1) {
      console.error(`Applying event ${events[0]?.runId}:${events[0]?.seq} failed`, error);
      return false;
    }
    const half = Math.ceil(events.length / 2);
    return (
      (await applyPulled(ctx, events.slice(0, half))) &&
      (await applyPulled(ctx, events.slice(half)))
    );
  }
}

/**
 * Reads the run's events after the last one applied and applies them.
 * `done` only when Hercules said there are no more: until then the run's
 * ending is not recorded, or it would end without its reply.
 */
async function pullEvents(
  ctx: ActionCtx,
  config: ApiConfig,
  run: LoadedRun,
): Promise<"done" | "more" | "failed"> {
  let after = run.lastSeq;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const response = await callHercules(
      config,
      "GET",
      `/v1/agents/runs/${encodeURIComponent(run.runId)}/events?after=${after}&limit=${EVENT_PAGE_SIZE}`,
    );
    if (!response.ok || !isRecord(response.body)) return "failed";
    const data = Array.isArray(response.body["data"]) ? response.body["data"] : [];
    const events = data
      .map(readWireEvent)
      .filter((event): event is WireEvent => event !== null && event.runId === run.runId);
    if (events.length > 0) {
      if (!(await applyPulled(ctx, events))) return "failed";
      after = Math.max(after, ...events.map((event) => event.seq));
    }
    if (response.body["has_more"] !== true) return "done";
    // More is promised, and this page did not move past where it started.
    if (events.length === 0) return "failed";
  }
  return "more";
}

/**
 * Stops a run at Hercules that a cancel is waiting for. A run Hercules never
 * got is ended here. True when the run is over.
 */
async function cancelAtHercules(
  ctx: ActionCtx,
  config: ApiConfig,
  run: LoadedRun,
): Promise<boolean> {
  const response = await callHercules(
    config,
    "POST",
    `/v1/agents/runs/${encodeURIComponent(run.runId)}/cancel`,
  );
  if (response.ok) {
    const current = readRun(response.body);
    const outcome = current === null ? null : outcomeFromRun(current);
    if (outcome === null) return false;
    await ctx.runMutation(internal.hercules.recordRun, { runId: run.runId, outcome });
    return true;
  }
  if (response.status === 404 && !run.accepted) {
    await ctx.runMutation(internal.hercules.endRun, { runId: run.runId, outcome: CANCELLED });
    return true;
  }
  return false;
}

type StartStep =
  /** Hercules has the run, or the run is over: nothing more to send. */
  | { kind: "done" }
  /** It may pass if sent again. */
  | { kind: "retry"; response: Extract<HerculesResponse, { ok: false }> }
  /** The thread is held by the run before this one, for a moment. */
  | { kind: "busy"; response: Extract<HerculesResponse, { ok: false }> };

/**
 * Sends the run to Hercules once and records the answer. The same run id
 * makes sending it again safe, and the body is the same every time.
 */
async function sendRun(ctx: ActionCtx, config: ApiConfig, run: LoadedRun): Promise<StartStep> {
  if (run.request === null) {
    await ctx.runMutation(internal.hercules.endRun, {
      runId: run.runId,
      outcome: failed("run_failed", "The run's request is gone, so it cannot be started."),
    });
    return { kind: "done" };
  }
  const response = await callHercules(
    config,
    "POST",
    `/v1/agents/${encodeURIComponent(run.agentId)}/runs`,
    {
      run_id: run.runId,
      thread_id: run.threadId,
      ...(run.endUser !== null && {
        end_user: { token_identifier: run.endUser.tokenIdentifier },
      }),
      input: [{ type: "text", text: run.request.input }],
      ...(run.request.context !== undefined && { context: run.request.context }),
      ...(run.request.pageActions !== undefined && { page_actions: run.request.pageActions }),
      ...(run.exposeToolDetails && { expose_tool_details: true }),
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
    const outcome = started === null ? null : outcomeFromRun(started);
    if (outcome !== null) {
      // The run is already over at Hercules: settle it now, with what it wrote.
      // If its events cannot be read, the stuck-run check settles it later.
      if ((await pullEvents(ctx, config, run)) === "done") {
        await ctx.runMutation(internal.hercules.recordRun, { runId: run.runId, outcome });
      }
    } else if (cancelWaiting) {
      await ctx.scheduler.runAfter(0, internal.hercules.cancelRun, {
        runId: run.runId,
        api: config,
        attempt: 0,
      });
    }
    return { kind: "done" };
  }

  if (run.accepted) {
    // Hercules has the run, and only its live token was being asked for.
    // The run goes on without it: the stuck-run check asks again.
    console.error(
      `Hercules did not answer for run ${run.runId}'s live stream: ${response.status ?? "network"} ${response.code}`,
    );
    return { kind: "done" };
  }
  if (response.status === 409 && response.code === "thread_busy") {
    return { kind: "busy", response };
  }
  if (response.retryable) return { kind: "retry", response };
  console.error(
    `Hercules refused run ${run.runId}: ${response.status ?? "network"} ${response.code}`,
  );
  await ctx.runMutation(internal.hercules.refuseRun, {
    runId: run.runId,
    outcome: refused(response),
  });
  return { kind: "done" };
}

/** Sends a run to Hercules, retrying what may pass. The same run id makes a retry safe. */
export const startRun = internalAction({
  args: {
    runId: v.string(),
    api: vApi,
    attempt: v.number(),
    /** When Hercules first refused this run because its thread was busy. */
    busySince: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.hercules.loadRun, { runId: args.runId });
    if (run === null || isFinalStatus(run.status)) return null;
    // Done only once the live token is stored too: an event delivered before
    // the answer to a retried call marks the run accepted, with no token yet.
    if (run.accepted && run.hasLive) return null;
    if (run.cancelRequested) {
      if (args.attempt === 0 && !run.accepted) {
        // Never sent, so there is nothing to stop at Hercules.
        await ctx.runMutation(internal.hercules.endRun, { runId: run.runId, outcome: CANCELLED });
      } else {
        // An earlier try may have reached Hercules. The check retries if this fails.
        await cancelAtHercules(ctx, args.api, run);
      }
      return null;
    }

    const step = await sendRun(ctx, args.api, run);
    if (step.kind === "done") return null;

    const now = Date.now();
    if (step.kind === "busy") {
      const busySince = args.busySince ?? now;
      const waited = now - busySince;
      if (waited < THREAD_BUSY_RETRY_MS) {
        // These tries do not count toward the ones a failing call gets:
        // the wait doubles from a second to five, for a minute.
        await ctx.runMutation(internal.hercules.retryStart, {
          runId: run.runId,
          api: args.api,
          attempt: Math.max(args.attempt, 1),
          busySince,
          delayMs: Math.min(Math.max(waited, FIRST_RETRY_MS), THREAD_BUSY_MAX_DELAY_MS),
        });
        return null;
      }
    } else if (args.attempt + 1 < MAX_START_ATTEMPTS) {
      await ctx.runMutation(internal.hercules.retryStart, {
        runId: run.runId,
        api: args.api,
        attempt: args.attempt + 1,
        ...(args.busySince !== undefined && { busySince: args.busySince }),
        delayMs: retryDelayMs(args.attempt, step.response.retryAfterMs),
      });
      return null;
    }
    console.error(
      `Hercules did not take run ${run.runId}: ${step.response.status ?? "network"} ${step.response.code}`,
    );
    await ctx.runMutation(internal.hercules.refuseRun, {
      runId: run.runId,
      outcome: refused(step.response),
    });
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
 * The stuck-run check. While a run is going it runs every few minutes, and
 * it always schedules itself again until the run is over, so no run is left
 * open for good.
 *
 * - A run Hercules has not taken, whose start call is no longer trying (a
 *   scheduled action runs at most once, and can be lost): it sends the run
 *   itself, or stops it if a cancel is waiting. After a day it fails the run.
 * - A run with nothing delivered for `STUCK_AFTER_MS`: it reads the run's
 *   events from Hercules and applies what delivery missed. It records the
 *   run's ending only once every event before it is applied.
 */
export const checkRun = internalAction({
  args: { runId: v.string(), api: vApi },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Whatever goes wrong below, the check comes back: a run is never left open for good.
    let nextCheckMs: number | null = STUCK_AFTER_MS;
    try {
      nextCheckMs = await checkOnce(ctx, args.api, args.runId);
    } catch (error) {
      console.error(`Checking run ${args.runId} failed`, error);
    }
    if (nextCheckMs !== null) {
      await ctx.scheduler.runAfter(nextCheckMs, internal.hercules.checkRun, args);
    }
    return null;
  },
});

/** One pass of the stuck-run check. Returns how soon to check again, or null when the run is over. */
async function checkOnce(ctx: ActionCtx, config: ApiConfig, runId: string): Promise<number | null> {
  const run = await ctx.runQuery(internal.hercules.loadRun, { runId });
  if (run === null || isFinalStatus(run.status)) return null;
  const now = Date.now();
  const tooOld = now - run.createdAt > GIVE_UP_AFTER_MS;
  async function giveUp(message: string) {
    await ctx.runMutation(internal.hercules.endRun, {
      runId,
      outcome: failed("run_failed", message),
    });
    return null;
  }

  if (!run.accepted || !run.hasLive) {
    if (!run.accepted && tooOld) return giveUp("The run could not be started within a day.");
    const startPending = run.nextStartAt !== null && now < run.nextStartAt + START_GRACE_MS;
    if (!startPending) {
      if (run.cancelRequested) await cancelAtHercules(ctx, config, run);
      else await sendRun(ctx, config, run);
    }
    if (!run.accepted) return STUCK_AFTER_MS;
  }

  const quietFor = now - run.lastEventAt;
  if (quietFor < STUCK_AFTER_MS) return STUCK_AFTER_MS - quietFor;

  const pulled = await pullEvents(ctx, config, run);
  if (pulled === "more") return MORE_EVENTS_DELAY_MS;

  const response = await callHercules(
    config,
    "GET",
    `/v1/agents/runs/${encodeURIComponent(run.runId)}`,
  );
  if (response.ok) {
    if (run.missingSince !== null) {
      await ctx.runMutation(internal.hercules.noteMissing, { runId, since: null });
    }
    const current = readRun(response.body);
    const outcome = current === null ? null : outcomeFromRun(current);
    if (outcome !== null && pulled === "done") {
      await ctx.runMutation(internal.hercules.recordRun, { runId, outcome });
      return null;
    }
    // Still going, or over with events that could not be read yet.
    if (!tooOld) return STUCK_AFTER_MS;
    return giveUp(
      outcome === null
        ? "The run was still going at Hercules after a day."
        : "The run ended at Hercules, but its events could not be read for a day.",
    );
  }
  if (response.status === 404) {
    const since = run.missingSince ?? now;
    if (now - since >= MISSING_FINAL_AFTER_MS) return giveUp("Hercules has no record of this run.");
    if (run.missingSince === null) {
      await ctx.runMutation(internal.hercules.noteMissing, { runId, since });
    }
    return STUCK_AFTER_MS;
  }
  if (tooOld) return giveUp("Nothing was heard from Hercules about this run for a day.");
  return STUCK_AFTER_MS;
}
