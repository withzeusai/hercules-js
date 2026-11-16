/**
 * What the app calls, through `HerculesAgents` in `@usehercules/agents/convex`.
 * The component has no `ctx.auth`: the app passes the caller in as `owner`,
 * and every function here answers only to a thread's owner.
 */
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server.js";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  STUCK_AFTER_MS,
  documentBytes,
  inputMessageId,
  isThreadId,
  isoTime,
  jittered,
  newId,
  ownerOf,
  readMessages,
  runById,
  threadById,
  toolCallById,
  utf8Length,
  wasDeleted,
} from "./store.js";
import {
  MAX_INPUT_CHARS,
  PAGE_ACTION_LISTED_MS,
  isFinalStatus,
  isPageActionFresh,
  runInputText,
} from "./protocol.js";
import { vApi, vEndUser, vThread, vThreadDetails } from "./validators.js";

const vSendResult = v.union(
  v.object({ ok: v.literal(true), threadId: v.string(), runId: v.string() }),
  v.object({
    ok: v.literal(false),
    code: v.string(),
    message: v.string(),
    retryAfterSeconds: v.optional(v.number()),
  }),
);
type SendResult = Infer<typeof vSendResult>;

/**
 * Starts a run: writes the user's message and the run, then schedules the
 * call to Hercules. On a new thread when `threadId` is left out, or is a new
 * UUID or ULID: the page may choose its thread's id, as TanStack AI's chat
 * does. Fails, with nothing written, when the thread is not the caller's or
 * was deleted, a run is still going on it, or the caller is over
 * `runsPerHour`.
 */
export const send = mutation({
  args: {
    agentId: v.string(),
    endUser: v.union(vEndUser, v.null()),
    threadId: v.optional(v.string()),
    text: v.string(),
    context: v.optional(v.record(v.string(), v.any())),
    pageActions: v.optional(v.array(v.string())),
    /** Runs one end user may start on this agent in an hour. */
    runsPerHour: v.optional(v.number()),
    /** A function handle, called with `RunFinished` once the run is done. */
    onRunFinished: v.optional(v.string()),
    /** Whether a page may see tool results and Hercules's own tool names. */
    exposeToolDetails: v.optional(v.boolean()),
    api: vApi,
  },
  returns: vSendResult,
  handler: async (ctx, args): Promise<SendResult> => {
    const owner = ownerOf(args.endUser);
    const now = Date.now();

    if (args.text.trim().length === 0) {
      return { ok: false, code: "invalid_request", message: "The message is empty." };
    }
    // Measured as Hercules measures it, so what it would refuse is never stored.
    if (runInputText(args.text, args.context).length > MAX_INPUT_CHARS) {
      return {
        ok: false,
        code: "message_too_long",
        message: `The message and its context are longer than ${MAX_INPUT_CHARS} characters.`,
      };
    }

    let thread = args.threadId === undefined ? null : await threadById(ctx, args.threadId);
    if (args.threadId !== undefined && thread === null) {
      // A new thread, under the id the page chose. The API takes only these.
      if (!isThreadId(args.threadId)) {
        return {
          ok: false,
          code: "invalid_request",
          message:
            "A new thread's id must be a UUID in lowercase, as crypto.randomUUID() makes, or a ULID in uppercase.",
        };
      }
      // A deleted thread's id stays taken: its rows may still be going, here and at Hercules.
      if (await wasDeleted(ctx, args.threadId)) {
        return {
          ok: false,
          code: "thread_deleted",
          message: "This thread was deleted. Start a new one under a new id.",
        };
      }
    } else if (thread !== null) {
      // A thread that is someone else's reads as one that does not exist.
      if (thread.owner !== owner || thread.agentId !== args.agentId) {
        return { ok: false, code: "not_found", message: "No such thread." };
      }
      if (thread.activeRunId !== null) {
        const active = await runById(ctx, thread.activeRunId);
        if (active !== null && !isFinalStatus(active.status)) {
          return {
            ok: false,
            code: "thread_busy",
            message: "The agent is still answering in this thread.",
          };
        }
      }
    }

    if (args.endUser !== null && args.runsPerHour !== undefined) {
      const recent = await ctx.db
        .query("runs")
        .withIndex("by_owner", (q) =>
          q
            .eq("owner", owner)
            .eq("agentId", args.agentId)
            .gt("_creationTime", now - 60 * 60 * 1000),
        )
        .take(Math.max(0, Math.floor(args.runsPerHour)) + 1);
      if (recent.length >= args.runsPerHour) {
        const oldest = recent[0]?._creationTime ?? now;
        return {
          ok: false,
          code: "end_user_rate_limited",
          message: "Too many messages in the last hour. Try again later.",
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000)),
        };
      }
    }

    if (thread === null) {
      const threadDocId = await ctx.db.insert("threads", {
        threadId: args.threadId ?? newId(),
        agentId: args.agentId,
        owner,
        activeRunId: null,
        updatedAt: now,
      });
      thread = (await ctx.db.get(threadDocId))!;
    }

    const runId = newId();
    const runDocId = await ctx.db.insert("runs", {
      runId,
      threadId: thread.threadId,
      agentId: args.agentId,
      owner,
      endUser: args.endUser,
      status: "queued",
      exposeToolDetails: args.exposeToolDetails === true,
      output: null,
      error: null,
      cappedReason: null,
      usage: null,
      progress: null,
      liveUrl: null,
      liveToken: null,
      accepted: false,
      cancelRequested: false,
      nextStartAt: null,
      missingSince: null,
      quietChecks: 0,
      lastSeq: 0,
      lastEventAt: now,
      finishedAt: null,
      onRunFinished: args.onRunFinished ?? null,
    });
    const run = (await ctx.db.get(runDocId))!;
    await ctx.db.insert("run_requests", {
      runId,
      threadId: thread.threadId,
      input: args.text,
      ...(args.context !== undefined && { context: args.context }),
      ...(args.pageActions !== undefined && { pageActions: args.pageActions }),
    });
    await ctx.db.insert("messages", {
      messageId: inputMessageId(runId),
      threadId: thread.threadId,
      runId,
      role: "user",
      status: "completed",
      parts: [{ type: "text", text: args.text }],
      segment: 0,
      continuesText: false,
      createdAt: isoTime(now),
      runOrder: run._creationTime,
      firstSeq: 0,
    });
    await ctx.db.patch(thread._id, { activeRunId: runId, updatedAt: now });

    await ctx.scheduler.runAfter(0, internal.hercules.startRun, {
      runId,
      api: args.api,
      attempt: 0,
    });
    // The stuck-run check is driven by a mutation, which cannot be lost.
    // Jittered, so runs sent in a burst do not all tick at the same moment.
    await ctx.scheduler.runAfter(jittered(STUCK_AFTER_MS), internal.hercules.tickRun, {
      runId,
      api: args.api,
    });
    return { ok: true, threadId: thread.threadId, runId };
  },
});

/** The most page actions a thread lists. Each can hold 256 KiB of arguments. */
const MAX_LISTED_PAGE_ACTIONS = 20;

/** What a read returns of a thread, to its owner or to the app's backend. */
async function threadView(
  ctx: QueryCtx,
  thread: Doc<"threads">,
  limit: number | undefined,
  hideTools: boolean,
): Promise<Infer<typeof vThread>> {
  // A caller's `limit` is its own to send: anything that is not a whole
  // number of at least one (NaN and Infinity among them) reads as the default.
  const asked = limit !== undefined && Number.isFinite(limit) && limit >= 1 ? limit : null;
  const count = Math.min(MAX_MESSAGE_LIMIT, Math.floor(asked ?? DEFAULT_MESSAGE_LIMIT));
  const active = thread.activeRunId === null ? null : await runById(ctx, thread.activeRunId);
  const run = active === null || isFinalStatus(active.status) ? null : active;
  const { messages, hasMore } = await readMessages(
    ctx,
    thread.threadId,
    count,
    hideTools,
    run?.runId ?? null,
  );

  const activeRun =
    run === null
      ? null
      : {
          id: run.runId,
          status: run.status as "queued" | "running",
          progress: run.progress,
          live:
            run.liveUrl !== null && run.liveToken !== null
              ? { url: run.liveUrl, token: run.liveToken }
              : null,
          lastSeq: run.lastSeq,
          created_at: isoTime(run._creationTime),
          stopping: run.cancelRequested,
        };

  const latest = await ctx.db
    .query("runs")
    .withIndex("by_thread", (q) => q.eq("threadId", thread.threadId))
    .order("desc")
    .first();
  const latestRun =
    latest === null
      ? null
      : {
          id: latest.runId,
          status: latest.status,
          error: latest.error,
          cappedReason: latest.cappedReason,
          finished_at: latest.finishedAt === null ? null : isoTime(latest.finishedAt),
        };

  // The page actions that arrived lately and no tab has run. One whose
  // event is two minutes old is listed as expired, so the page can say that
  // it came too late. A query is not rerun as time passes: the claim, on
  // the server's clock, has the last word, and marks what it refuses.
  const now = Date.now();
  const pageActions: Infer<typeof vThread>["pageActions"] = [];
  // Oldest first, and the cap counts only what no tab has run: the ones a
  // tab already took must not push a waiting one off the list.
  for await (const call of ctx.db.query("tool_calls").withIndex("by_thread", (q) =>
    q
      .eq("threadId", thread.threadId)
      .eq("kind", "page")
      .gt("_creationTime", now - PAGE_ACTION_LISTED_MS),
  )) {
    if (call.claimedAt !== null || call.argumentsJson === null) continue;
    pageActions.push({
      toolCallId: call.toolCallId,
      runId: call.runId,
      name: call.name,
      argumentsJson: call.argumentsJson,
      created_at: isoTime(call.createdAt),
      status: !call.expired && isPageActionFresh(call.createdAt, now) ? "pending" : "expired",
    });
    if (pageActions.length === MAX_LISTED_PAGE_ACTIONS) break;
  }

  return {
    id: thread.threadId,
    agentId: thread.agentId,
    messages,
    hasMore,
    activeRun,
    latestRun,
    pageActions,
  };
}

/**
 * The thread, when it is this caller's and this agent's. An app can have
 * several agents: each reaches only its own threads, so one agent's
 * settings (what a page may see of tools) never apply to another's thread.
 */
async function ownThread(
  ctx: QueryCtx,
  args: { threadId: string; agentId: string; owner: string },
): Promise<Doc<"threads"> | null> {
  const thread = await threadById(ctx, args.threadId);
  if (thread === null || thread.owner !== args.owner || thread.agentId !== args.agentId) {
    return null;
  }
  return thread;
}

/**
 * A thread as its owner sees it: the latest messages, the run that is going
 * with what the browser needs to stream it, and page actions waiting for a
 * tab. Null for a thread that does not exist or is not the caller's.
 *
 * It goes to a browser, so unless the app set `exposeToolDetails` a
 * `hercules` tool call is named "tool" with a summary that says only whether
 * it worked. No tool call carries its result either way.
 */
export const read = query({
  args: {
    threadId: v.string(),
    agentId: v.string(),
    owner: v.string(),
    limit: v.optional(v.number()),
    exposeToolDetails: v.optional(v.boolean()),
  },
  returns: v.union(vThread, v.null()),
  handler: async (ctx, args): Promise<Infer<typeof vThread> | null> => {
    const thread = await ownThread(ctx, args);
    if (thread === null) return null;
    return await threadView(ctx, thread, args.limit, args.exposeToolDetails !== true);
  },
});

/** The most tool result text one `readDetails` returns. */
const MAX_DETAIL_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * A thread as the component stores it, for the app's own backend: tool calls
 * under their own names, and the tool calls of the listed messages' runs with
 * their results. It answers to no owner: the app decides who may ask, and
 * must not hand it to a page.
 */
export const readDetails = query({
  args: { threadId: v.string(), agentId: v.string(), limit: v.optional(v.number()) },
  returns: v.union(vThreadDetails, v.null()),
  handler: async (ctx, args): Promise<Infer<typeof vThreadDetails> | null> => {
    const thread = await threadById(ctx, args.threadId);
    if (thread === null || thread.agentId !== args.agentId) return null;
    const view = await threadView(ctx, thread, args.limit, false);
    const runIds = [...new Set(view.messages.map((message) => message.run_id))];
    const details: Doc<"tool_calls">[] = [];
    let resultBytes = 0;
    let toolCallsTruncated = false;
    // The newest runs first, so they are the ones a read that runs out of room has.
    for (const runId of runIds.reverse()) {
      const calls = await ctx.db
        .query("tool_calls")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect();
      resultBytes += calls.reduce((sum, call) => sum + utf8Length(call.resultJson ?? ""), 0);
      if (resultBytes > MAX_DETAIL_RESULT_BYTES && details.length > 0) {
        toolCallsTruncated = true;
        break;
      }
      details.push(...calls);
    }
    // In the order the agent made them: by their events' time, then by arrival.
    details.sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
    const toolCalls = details.map((call) => ({
      toolCallId: call.toolCallId,
      runId: call.runId,
      name: call.name,
      kind: call.kind,
      status: call.status,
      summary: call.summary,
      resultJson: call.resultJson,
      argumentsJson: call.argumentsJson,
      created_at: isoTime(call.createdAt),
    }));
    return { ...view, toolCalls, toolCallsTruncated };
  },
});

/**
 * Stops the thread's run, if one is going. True when there was one to stop.
 * The run is only marked here (`cancelRequested`, which the thread reports
 * as `activeRun.stopping`): it ends when Hercules says it has stopped.
 */
export const cancel = mutation({
  args: { threadId: v.string(), agentId: v.string(), owner: v.string(), api: vApi },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ownThread(ctx, args);
    if (thread === null || thread.activeRunId === null) return false;
    const run = await runById(ctx, thread.activeRunId);
    if (run === null || isFinalStatus(run.status)) return false;
    if (!run.cancelRequested) await ctx.db.patch(run._id, { cancelRequested: true });
    // Not taken yet: the start call sees the request and never sends the run,
    // and the stuck-run check sees it if the start call was lost.
    if (!run.accepted) return true;
    // If this call gives up, the stuck-run check asks again.
    await ctx.scheduler.runAfter(0, internal.hercules.cancelRun, {
      runId: run.runId,
      api: args.api,
      attempt: 0,
    });
    return true;
  },
});

/**
 * Deletes a thread: here at once, and at Hercules, which also stops its run
 * and revokes its live tokens. Irreversible, and its id is never used again:
 * a later `send` under it is refused. True when there was one to delete.
 *
 * What is left to do is kept in `deleted_threads`: the thread's other rows
 * are purged in batches, and Hercules is asked until it confirms.
 */
export const remove = mutation({
  args: { threadId: v.string(), agentId: v.string(), owner: v.string(), api: vApi },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ownThread(ctx, args);
    if (thread === null) return false;
    // The token of a run still going is dropped now, not when its rows are purged.
    const active = thread.activeRunId === null ? null : await runById(ctx, thread.activeRunId);
    if (active !== null && active.liveToken !== null) {
      await ctx.db.patch(active._id, { liveUrl: null, liveToken: null });
    }
    const now = Date.now();
    await ctx.db.delete(thread._id);
    await ctx.db.insert("deleted_threads", {
      threadId: thread.threadId,
      deletedAt: now,
      purgedAt: null,
      remoteDeletedAt: null,
      remoteGaveUpAt: null,
      remoteMissingSince: null,
      attempts: 0,
      nextAttemptAt: now,
      purgeProgressAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId: thread.threadId });
    await ctx.scheduler.runAfter(0, internal.hercules.deleteTick, {
      threadId: thread.threadId,
      api: args.api,
    });
    return true;
  },
});

/** The most rows one purge batch deletes. */
const PURGE_BATCH_ROWS = 200;
/**
 * The most bytes one purge batch reads. A row can be close to 1 MiB (a
 * message segment, a chunk, a tool result), so rows are read a few at a time
 * and the batch stops once it is past this: far below what a mutation may read.
 */
const PURGE_BATCH_BYTES = 3 * 1024 * 1024;
const PURGE_STEP_ROWS = 2;

/**
 * Deletes a removed thread's rows, a batch at a time, by bytes as well as by
 * count. When none is left it says so on the thread's `deleted_threads` row.
 * `hercules.deleteTick` starts it again if a batch is lost or fails.
 */
export const purge = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const tables = ["runs", "run_requests", "message_chunks", "messages", "tool_calls"] as const;
    const deleted = await ctx.db
      .query("deleted_threads")
      .withIndex("by_thread_id", (q) => q.eq("threadId", threadId))
      .first();
    // Says the purge is alive, so the tick does not start a second one.
    if (deleted !== null) await ctx.db.patch(deleted._id, { purgeProgressAt: Date.now() });
    let rows = 0;
    let bytes = 0;
    for (const table of tables) {
      for (;;) {
        if (rows >= PURGE_BATCH_ROWS || bytes >= PURGE_BATCH_BYTES) {
          await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId });
          return null;
        }
        // Runs first: they hold the live tokens. What is deleted is gone from
        // the next read, so the rows still there are where the purge stands.
        const step = await ctx.db
          .query(table)
          .withIndex("by_thread", (q) => q.eq("threadId", threadId))
          .take(PURGE_STEP_ROWS);
        if (step.length === 0) break;
        for (const row of step) {
          bytes += documentBytes(row);
          rows++;
          await ctx.db.delete(row._id);
        }
      }
    }
    if (deleted !== null && deleted.purgedAt === null) {
      await ctx.db.patch(deleted._id, { purgedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Takes a page action for one tab to run. True for the first tab to ask.
 * False for every other, for a call the run did not make (only a delivered
 * `page_action` can be claimed), and for one whose event is two minutes old
 * or more: its moment has passed, however late it was delivered. That one is
 * marked expired, which the thread then says of it.
 */
export const claimPageAction = mutation({
  args: {
    threadId: v.string(),
    agentId: v.string(),
    owner: v.string(),
    runId: v.string(),
    toolCallId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ownThread(ctx, args);
    if (thread === null) return false;
    const call = await toolCallById(ctx, args.runId, args.toolCallId);
    if (call === null || call.threadId !== thread.threadId) return false;
    if (call.kind !== "page" || call.claimedAt !== null || call.expired) return false;
    const now = Date.now();
    if (!isPageActionFresh(call.createdAt, now)) {
      await ctx.db.patch(call._id, { expired: true });
      return false;
    }
    await ctx.db.patch(call._id, { claimedAt: now });
    return true;
  },
});
