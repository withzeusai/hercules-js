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
  type QueryCtx,
} from "./_generated/server.js";
import {
  HERCULES_API_VERSION,
  isFinalStatus,
  readRun,
  readWireEvent,
  type Run,
  type WireEvent,
} from "./protocol.js";
import { STUCK_AFTER_MS, finishRun, jittered, runById, type RunOutcome } from "./store.js";
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
/** How many times a start refused as `rate_limited` is sent before the run fails with that. */
const MAX_RATE_LIMITED_STARTS = 8;
/** The longest wait between two tries of a start Hercules could not answer. */
const START_RETRY_CAP_MS = 2 * 60 * 1000;
/** The longest wait between two checks of a run Hercules says is still going. */
const MAX_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CANCEL_ATTEMPTS = 6;
/** A run that could not be settled for this long is given up on. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * How long past that the check itself is given to end the run, with what it
 * learned from Hercules, before the tick ends it without asking.
 */
const GIVE_UP_GRACE_MS = 30 * 60 * 1000;
/** Hercules is asked to delete a thread for this long. */
const DELETE_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const DELETE_FIRST_RETRY_MS = 5 * 1000;
/** How often a deleted thread whose rows are not purged yet is looked at again. */
const PURGE_WATCH_MS = 60 * 1000;
/** A purge with no batch for this long has stopped, and is started again. */
const PURGE_STALLED_AFTER_MS = 2 * 60 * 1000;
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
      /** The run Hercules says it has, in a refusal's `details.run_id`. */
      detailsRunId: string | null;
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
      detailsRunId: null,
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
    detailsRunId:
      isRecord(problem["details"]) && typeof problem["details"]["run_id"] === "string"
        ? problem["details"]["run_id"]
        : null,
  };
}

/**
 * How long to wait before the next try. Never less than Hercules asked
 * (`retryAfter`), and otherwise a backoff that starts at a second and
 * doubles up to `capMs`. Always jittered, so callers that failed together do
 * not come back together: the wait is spread over the upper half of the
 * backoff, or over a tenth of what Hercules asked when that is more.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter: number | null,
  capMs = MAX_RETRY_MS,
): number {
  const backoff = Math.min(FIRST_RETRY_MS * 2 ** attempt, capMs);
  const asked = Math.min(retryAfter ?? 0, MAX_RETRY_MS);
  const least = Math.max(asked, backoff / 2);
  return Math.floor(least + Math.random() * Math.max(backoff / 2, asked / 10));
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
  if (status === 404) {
    // Not a thread that is gone: the app is set up wrong, and a new chat will not help.
    return failed(
      "agent_not_found",
      "Hercules has no agent with this id for this app, or the agents API is not turned on for it. Check the agent id the app was set up with.",
    );
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
  quietChecks: v.number(),
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
      quietChecks: run.quietChecks,
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
 *
 * The run stays `accepted: false`, and that is the mark its thread carries:
 * a thread none of whose runs Hercules took is never named to Hercules again
 * except in a new run, which says who it is for (see `remove` in `./threads`).
 * Hercules answers 404 both for an agent it does not have and for a thread
 * it will not open for this caller, and the two cannot be told apart here.
 * So the thread is kept, for its owner to read the failure on and to send in
 * again once the app is set up right.
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

/**
 * Notes that a check found the run still going at Hercules, with nothing new
 * to apply: the next check waits twice as long. A delivered event resets it.
 */
export const noteStillGoing = internalMutation({
  args: { runId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run !== null && !isFinalStatus(run.status)) {
      await ctx.db.patch(run._id, { quietChecks: run.quietChecks + 1 });
    }
    return null;
  },
});

/** How long a run must have been quiet before it is checked: 3 minutes, doubling to 30. */
function checkIntervalMs(quietChecks: number): number {
  return Math.min(STUCK_AFTER_MS * 2 ** Math.min(quietChecks, 10), MAX_CHECK_INTERVAL_MS);
}

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
  /** Set to true when an event was applied. */
  seen: { applied: boolean } = { applied: false },
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
      seen.applied = true;
      after = Math.max(after, ...events.map((event) => event.seq));
    }
    if (response.body["has_more"] !== true) return "done";
    // More is promised, and this page did not move past where it started.
    if (events.length === 0) return "failed";
  }
  return "more";
}

/**
 * Records the ending Hercules gave a run it was asked to stop. What the run
 * wrote before it stopped is read first, as the stuck-run check does: the
 * answer to a cancel can come before delivery has brought the run's last
 * events, and a run that is over is never checked again. A read that fails
 * does not hold the ending back: once the run has stopped, the thread is free.
 */
async function recordStopped(
  ctx: ActionCtx,
  config: ApiConfig,
  run: LoadedRun,
  outcome: RunOutcome,
): Promise<void> {
  await pullEvents(ctx, config, run);
  await ctx.runMutation(internal.hercules.recordRun, { runId: run.runId, outcome });
}

/**
 * Notes that Hercules has a run whose start it never answered: it answered
 * for the run by its id, which only a run it took has there.
 */
async function noteTaken(ctx: ActionCtx, runId: string): Promise<void> {
  await ctx.runMutation(internal.hercules.recordAccepted, { runId, status: null, live: null });
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
    // Hercules knows the run, so it took it: a start call reached it and the
    // answer was lost. Noted, so the thread counts as one Hercules has.
    if (!run.accepted) await noteTaken(ctx, run.runId);
    const current = readRun(response.body);
    const outcome = current === null ? null : outcomeFromRun(current);
    if (outcome === null) return false;
    await recordStopped(ctx, config, run, outcome);
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

  // "Start unconfirmed": Hercules has the run (its id is in the refusal) and
  // could not say yet that it started. The run is its now: delivered events
  // and the stuck-run check settle it, whatever the retries below bring.
  let accepted = run.accepted;
  if (!accepted && response.detailsRunId === run.runId) {
    accepted = true;
    const cancelWaiting = await ctx.runMutation(internal.hercules.recordAccepted, {
      runId: run.runId,
      status: null,
      live: null,
    });
    if (cancelWaiting) {
      await ctx.scheduler.runAfter(0, internal.hercules.cancelRun, {
        runId: run.runId,
        api: config,
        attempt: 0,
      });
    }
  }
  if (accepted) {
    // Hercules has the run, and only its live token is still wanted. A
    // refusal never ends the run: it goes on without the token.
    if (response.retryable) return { kind: "retry", response };
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
          delayMs: jittered(Math.min(Math.max(waited, FIRST_RETRY_MS), THREAD_BUSY_MAX_DELAY_MS)),
        });
        return null;
      }
    } else if (step.response.status !== 429 || args.attempt + 1 < MAX_RATE_LIMITED_STARTS) {
      // A 5xx, a timeout or a network error says nothing about the run:
      // Hercules may have it, and answers 503 while it cannot tell. So the
      // run stays open and the same run id is sent again, as told and then
      // further and further apart, until Hercules answers with the run or
      // refuses it. A run it never takes is failed by the tick after a day.
      // Only `rate_limited`, which is an answer, runs out of tries.
      await ctx.runMutation(internal.hercules.retryStart, {
        runId: run.runId,
        api: args.api,
        attempt: args.attempt + 1,
        ...(args.busySince !== undefined && { busySince: args.busySince }),
        delayMs: retryDelayMs(args.attempt, step.response.retryAfterMs, START_RETRY_CAP_MS),
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
  args: {
    runId: v.string(),
    api: vApi,
    attempt: v.number(),
    /** The run's start was never answered, so whether Hercules has it is not known. */
    unconfirmed: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const response = await callHercules(
      args.api,
      "POST",
      `/v1/agents/runs/${encodeURIComponent(args.runId)}/cancel`,
    );
    if (response.ok) {
      if (args.unconfirmed === true) await noteTaken(ctx, args.runId);
      const current = readRun(response.body);
      const outcome = current === null ? null : outcomeFromRun(current);
      if (outcome !== null) {
        const run = await ctx.runQuery(internal.hercules.loadRun, { runId: args.runId });
        if (run !== null && !isFinalStatus(run.status)) {
          await recordStopped(ctx, args.api, run, outcome);
        }
        return null;
      }
      // Hercules took the stop, and the run had not ended when it answered.
      // Asked again soon, so the thread is free when it has, without waiting
      // for the ending to be delivered or for the stuck-run check.
      if (current !== null && args.attempt + 1 < MAX_CANCEL_ATTEMPTS) {
        await ctx.scheduler.runAfter(
          retryDelayMs(args.attempt, null),
          internal.hercules.cancelRun,
          { ...args, attempt: args.attempt + 1 },
        );
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

/** The `deleted_threads` row of a thread: what is left to do about it. */
async function deletedThread(ctx: QueryCtx, threadId: string) {
  return await ctx.db
    .query("deleted_threads")
    .withIndex("by_thread_id", (q) => q.eq("threadId", threadId))
    .first();
}

/**
 * Records an answer about a deleted thread that was not a yes. A 404 is "it
 * is not there". But Hercules also answers 404 on every route while the
 * agents API is off for the app, so one 404 is not taken for it: it must
 * still be the answer an hour later.
 */
async function noteNotDeleted(
  ctx: ActionCtx,
  threadId: string,
  response: Extract<HerculesResponse, { ok: false }>,
): Promise<void> {
  if (response.status === 404) {
    await ctx.runMutation(internal.hercules.noteDelete, { threadId, outcome: "missing" });
    return;
  }
  // An answer that asking again cannot change: the request or the key is wrong.
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    console.error(
      `Hercules refused to delete thread ${threadId}: ${response.status} ${response.code}`,
    );
    await ctx.runMutation(internal.hercules.noteDelete, { threadId, outcome: "refused" });
    return;
  }
  // Anything else may pass: Hercules answers 409 `thread_busy` while the
  // thread's run is still stopping, and says when to ask again.
  await ctx.runMutation(internal.hercules.noteDelete, {
    threadId,
    outcome: "later",
    waitMs: Math.min(response.retryAfterMs ?? 0, MAX_RETRY_MS),
  });
}

/**
 * Asks Hercules once to delete a thread, and records what it said. It does
 * not try again itself: `deleteTick` does, and that cannot be lost.
 *
 * The delete names the thread and no end user. So it is sent only for a
 * thread Hercules took a run on, which it does for the thread's own end user
 * and no other. With `ifRun`, the thread was deleted before Hercules had
 * answered for any of its runs: Hercules is asked for that run first, by the
 * id this component gave it, and for the delete only if it has the run, on
 * this thread. A run it does not have (yet) reads as a thread that is not
 * there.
 */
export const deleteThread = internalAction({
  args: { threadId: v.string(), api: vApi, ifRun: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.ifRun !== undefined) {
      const asked = await callHercules(
        args.api,
        "GET",
        `/v1/agents/runs/${encodeURIComponent(args.ifRun)}`,
      );
      if (!asked.ok) {
        await noteNotDeleted(ctx, args.threadId, asked);
        return null;
      }
      const run = readRun(asked.body);
      if (run === null || run.id !== args.ifRun || run.thread_id !== args.threadId) {
        console.error(
          `Hercules did not place run ${args.ifRun} on thread ${args.threadId}, so the thread is not deleted there.`,
        );
        await ctx.runMutation(internal.hercules.noteDelete, {
          threadId: args.threadId,
          outcome: "refused",
        });
        return null;
      }
      await ctx.runMutation(internal.hercules.noteDelete, {
        threadId: args.threadId,
        outcome: "confirmed",
      });
    }
    const response = await callHercules(
      args.api,
      "DELETE",
      `/v1/agents/threads/${encodeURIComponent(args.threadId)}`,
    );
    if (response.ok) {
      await ctx.runMutation(internal.hercules.noteDelete, {
        threadId: args.threadId,
        outcome: "deleted",
      });
      return null;
    }
    await noteNotDeleted(ctx, args.threadId, response);
    return null;
  },
});

/** Records Hercules's answer to a delete on the thread's `deleted_threads` row. */
export const noteDelete = internalMutation({
  args: {
    threadId: v.string(),
    outcome: v.union(
      v.literal("deleted"),
      v.literal("missing"),
      v.literal("refused"),
      v.literal("later"),
      /** Hercules has the run the thread was waiting on: the thread is there, and this caller's. */
      v.literal("confirmed"),
    ),
    waitMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await deletedThread(ctx, args.threadId);
    if (row === null) return null;
    const now = Date.now();
    if (args.outcome === "deleted") await ctx.db.patch(row._id, { remoteDeletedAt: now });
    else if (args.outcome === "confirmed") {
      // From here on the delete is sent without asking for the run again.
      await ctx.db.patch(row._id, { unconfirmedRunId: undefined, remoteMissingSince: null });
    } else if (args.outcome === "refused") await ctx.db.patch(row._id, { remoteGaveUpAt: now });
    else if (args.outcome === "missing") {
      const since = row.remoteMissingSince ?? now;
      await ctx.db.patch(
        row._id,
        now - since >= MISSING_FINAL_AFTER_MS
          ? { remoteDeletedAt: now }
          : { remoteMissingSince: since },
      );
    } else {
      // Not before Hercules said, and not sooner than the tick had planned.
      // It answered something other than 404, so the thread is there.
      const until = now + (args.waitMs ?? 0);
      await ctx.db.patch(row._id, {
        remoteMissingSince: null,
        ...(until > row.nextAttemptAt && { nextAttemptAt: until }),
      });
    }
    return null;
  },
});

/**
 * Sees a deleted thread through: asks Hercules to delete its copy until it
 * confirms, and starts the purge of the thread's rows again if it stopped.
 * A thread Hercules never took a run on has no copy there: its row says so
 * from the start, and only the purge is seen through.
 *
 * It is a mutation that schedules itself, so it cannot be lost the way an
 * action can: Convex runs a scheduled mutation exactly once. Each time it
 * also schedules the one-shot action that calls Hercules. It ends when both
 * are done, or after a day, with what is left logged.
 */
export const deleteTick = internalMutation({
  args: { threadId: v.string(), api: vApi },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await deletedThread(ctx, args.threadId);
    if (row === null) return null;
    const now = Date.now();
    const remoteDone = row.remoteDeletedAt !== null || row.remoteGaveUpAt !== null;
    const purged = row.purgedAt !== null;
    if (remoteDone && purged) return null;
    if (now - row.deletedAt > DELETE_GIVE_UP_AFTER_MS) {
      console.error(
        `Gave up on deleted thread ${args.threadId} after a day: ${
          remoteDone ? "" : "Hercules did not confirm it deleted its copy. "
        }${purged ? "" : "Its rows are not all purged."}`,
      );
      if (!remoteDone) await ctx.db.patch(row._id, { remoteGaveUpAt: now });
      return null;
    }
    // A purge whose last batch was lost or failed is started again. One that
    // is still going stamps its progress with every batch, and is left alone:
    // a second chain beside it would only double the work.
    if (!purged && now - row.purgeProgressAt >= PURGE_STALLED_AFTER_MS) {
      await ctx.db.patch(row._id, { purgeProgressAt: now });
      await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId: args.threadId });
    }
    let next = PURGE_WATCH_MS;
    if (!remoteDone) {
      if (now >= row.nextAttemptAt) {
        const wait = jittered(
          Math.min(DELETE_FIRST_RETRY_MS * 2 ** Math.min(row.attempts, 10), MAX_RETRY_MS),
        );
        await ctx.db.patch(row._id, { attempts: row.attempts + 1, nextAttemptAt: now + wait });
        await ctx.scheduler.runAfter(0, internal.hercules.deleteThread, {
          ...args,
          ...(row.unconfirmedRunId !== undefined && { ifRun: row.unconfirmedRunId }),
        });
        next = wait;
      } else {
        next = row.nextAttemptAt - now;
      }
    }
    await ctx.scheduler.runAfter(next, internal.hercules.deleteTick, args);
    return null;
  },
});

/**
 * The stuck-run tick. While a run is going it comes back every few minutes
 * and, when the run needs looking at, starts `checkRun`.
 *
 * It is a mutation that schedules itself: Convex runs a scheduled mutation
 * exactly once, where a scheduled action runs at most once and can be lost.
 * So a lost check costs one tick, never the run: no run is left open for
 * good, and no thread stays busy behind one. It ends with the run. A run
 * nothing could settle in a day (and half an hour for the check to say why)
 * is failed here.
 */
export const tickRun = internalMutation({
  args: { runId: v.string(), api: vApi },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (run === null || isFinalStatus(run.status)) return null;
    const now = Date.now();
    const age = now - run._creationTime;
    const gaveUp = !run.accepted
      ? age > GIVE_UP_AFTER_MS && "The run could not be started within a day."
      : age > GIVE_UP_AFTER_MS + GIVE_UP_GRACE_MS && "The run could not be settled within a day.";
    if (gaveUp !== false) {
      await finishRun(ctx, run, failed("run_failed", gaveUp));
      // The thread is free here. Hercules may still have the run going and
      // hold the thread there, so it is asked to stop it, as well as can be.
      await ctx.scheduler.runAfter(0, internal.hercules.cancelRun, {
        ...args,
        attempt: 0,
        ...(!run.accepted && { unconfirmed: true }),
      });
      return null;
    }

    const quietFor = now - run.lastEventAt;
    const startPending = run.nextStartAt !== null && now < run.nextStartAt + START_GRACE_MS;
    // Hercules has not taken the run, or its live token never came, and no start call is trying.
    const needsStart = (!run.accepted || run.liveToken === null) && !startPending;
    // A cancel is asked again until the run is over: the call that carries it can give up.
    const needsCancel = run.cancelRequested && run.accepted;
    // A run Hercules keeps saying is going is looked at less and less often.
    const interval = checkIntervalMs(run.quietChecks);
    const quiet = run.accepted && quietFor >= interval;
    if (needsStart || needsCancel || quiet) {
      await ctx.scheduler.runAfter(0, internal.hercules.checkRun, args);
    }
    let next = STUCK_AFTER_MS;
    if (run.accepted && !needsStart && !needsCancel) {
      // Back when the run will have been quiet for long enough. After a check
      // that finds the run still going, that is the doubled wait; after one
      // that was lost, it is this same wait again.
      next = quiet ? interval : Math.max(MORE_EVENTS_DELAY_MS, interval - quietFor);
    }
    // Jittered, so runs that were sent together do not tick together.
    await ctx.scheduler.runAfter(jittered(next), internal.hercules.tickRun, args);
    return null;
  },
});

/**
 * The stuck-run check, one pass. `tickRun` starts it; it schedules nothing
 * that the run depends on.
 *
 * - A run Hercules has not taken, whose start call is no longer trying: it
 *   sends the run itself, or stops it if a cancel is waiting.
 * - A run with a cancel waiting: it asks Hercules to stop it again.
 * - A run with nothing delivered for `STUCK_AFTER_MS`: it reads the run from
 *   Hercules, then the run's events, and applies what delivery missed. It
 *   records the run's ending only when the events it read after seeing the
 *   run over were all of them: the reply is applied before the ending.
 */
export const checkRun = internalAction({
  args: { runId: v.string(), api: vApi },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.hercules.loadRun, { runId: args.runId });
    if (run === null || isFinalStatus(run.status)) return null;
    const now = Date.now();
    const tooOld = now - run.createdAt > GIVE_UP_AFTER_MS;
    async function giveUp(message: string, stillGoing = false) {
      await ctx.runMutation(internal.hercules.endRun, {
        runId: args.runId,
        outcome: failed("run_failed", message),
      });
      // The thread is free here. If Hercules still has the run going it holds
      // the thread there, so it is asked to stop it, as well as can be.
      if (stillGoing) {
        await callHercules(
          args.api,
          "POST",
          `/v1/agents/runs/${encodeURIComponent(args.runId)}/cancel`,
        );
      }
      return null;
    }

    if (!run.accepted || !run.hasLive) {
      const startPending = run.nextStartAt !== null && now < run.nextStartAt + START_GRACE_MS;
      if (!startPending) {
        if (run.cancelRequested) await cancelAtHercules(ctx, args.api, run);
        else await sendRun(ctx, args.api, run);
      }
      if (!run.accepted) return null;
    } else if (run.cancelRequested) {
      if (await cancelAtHercules(ctx, args.api, run)) return null;
    }
    if (now - run.lastEventAt < checkIntervalMs(run.quietChecks)) return null;

    // The run first, then its events: an ending is recorded only when the
    // events read after the run was seen over are complete. Read the other
    // way round, a reply written between the two reads would be missed.
    const response = await callHercules(
      args.api,
      "GET",
      `/v1/agents/runs/${encodeURIComponent(run.runId)}`,
    );
    if (response.ok) {
      if (run.missingSince !== null) {
        await ctx.runMutation(internal.hercules.noteMissing, { runId: run.runId, since: null });
      }
      const current = readRun(response.body);
      const outcome = current === null ? null : outcomeFromRun(current);
      const seen = { applied: false };
      const pulled = await pullEvents(ctx, args.api, run, seen);
      if (pulled === "more") {
        // More events than one pass reads. Soon, if this is not lost; at the next tick if it is.
        await ctx.scheduler.runAfter(MORE_EVENTS_DELAY_MS, internal.hercules.checkRun, args);
        return null;
      }
      if (outcome !== null && pulled === "done") {
        await ctx.runMutation(internal.hercules.recordRun, { runId: run.runId, outcome });
        return null;
      }
      if (tooOld) {
        return outcome === null
          ? giveUp("The run was still going at Hercules after a day.", true)
          : giveUp("The run ended at Hercules, but its events could not be read for a day.");
      }
      // Still going with nothing new: the next check waits longer. (Events it
      // just applied reset the wait, as delivered ones do.)
      if (outcome === null && pulled === "done" && !seen.applied) {
        await ctx.runMutation(internal.hercules.noteStillGoing, { runId: run.runId });
      }
      return null;
    }
    if (response.status === 404) {
      const since = run.missingSince ?? now;
      if (now - since >= MISSING_FINAL_AFTER_MS) {
        return giveUp("Hercules has no record of this run.");
      }
      if (run.missingSince === null) {
        await ctx.runMutation(internal.hercules.noteMissing, { runId: run.runId, since });
      }
      return null;
    }
    if (tooOld) return giveUp("Nothing was heard from Hercules about this run for a day.");
    return null;
  },
});
