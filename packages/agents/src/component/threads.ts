/**
 * What the app calls, through `HerculesAgents` in `@usehercules/agents/convex`.
 * The component has no `ctx.auth`: the app passes the caller in as `owner`,
 * and every function here answers only to a thread's owner.
 */
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_INPUT_CHARS,
  MAX_MESSAGE_LIMIT,
  PAGE_ACTION_TTL_MS,
  STUCK_AFTER_MS,
  inputMessageId,
  isoTime,
  newId,
  ownerOf,
  readMessages,
  runById,
  threadById,
} from "./store.js";
import { isFinalStatus } from "./protocol.js";
import { vApi, vEndUser, vThread } from "./validators.js";

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
 * call to Hercules. On a new thread when `threadId` is left out. Fails, with
 * nothing written, when the thread is not the caller's, a run is still going
 * on it, or the caller is over `runsPerHour`.
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
    api: vApi,
  },
  returns: vSendResult,
  handler: async (ctx, args): Promise<SendResult> => {
    const owner = ownerOf(args.endUser);
    const now = Date.now();

    if (args.text.trim().length === 0) {
      return { ok: false, code: "invalid_request", message: "The message is empty." };
    }
    const contextChars = args.context === undefined ? 0 : JSON.stringify(args.context).length;
    if (args.text.length + contextChars > MAX_INPUT_CHARS) {
      return {
        ok: false,
        code: "message_too_long",
        message: `The message and its context are longer than ${MAX_INPUT_CHARS} characters.`,
      };
    }

    let thread = args.threadId === undefined ? null : await threadById(ctx, args.threadId);
    if (args.threadId !== undefined) {
      // A thread that is someone else's reads as one that does not exist.
      if (thread === null || thread.owner !== owner || thread.agentId !== args.agentId) {
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
        threadId: newId(),
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
      input: args.text,
      ...(args.context !== undefined && { context: args.context }),
      ...(args.pageActions !== undefined && { pageActions: args.pageActions }),
      output: null,
      error: null,
      cappedReason: null,
      usage: null,
      progress: null,
      liveUrl: null,
      liveToken: null,
      accepted: false,
      cancelRequested: false,
      lastSeq: 0,
      lastEventAt: now,
      finishedAt: null,
      onRunFinished: args.onRunFinished ?? null,
    });
    const run = (await ctx.db.get(runDocId))!;
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
    await ctx.scheduler.runAfter(STUCK_AFTER_MS, internal.hercules.checkRun, {
      runId,
      api: args.api,
    });
    return { ok: true, threadId: thread.threadId, runId };
  },
});

/**
 * A thread as its owner sees it: the latest messages, the run that is going
 * with what the browser needs to stream it, and page actions waiting for a
 * tab. Null for a thread that does not exist or is not the caller's.
 */
export const read = query({
  args: {
    threadId: v.string(),
    owner: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.union(vThread, v.null()),
  handler: async (ctx, args): Promise<Infer<typeof vThread> | null> => {
    const thread = await threadById(ctx, args.threadId);
    if (thread === null || thread.owner !== args.owner) return null;
    const limit = Math.min(
      MAX_MESSAGE_LIMIT,
      Math.max(1, Math.floor(args.limit ?? DEFAULT_MESSAGE_LIMIT)),
    );
    const { messages, hasMore } = await readMessages(ctx, thread.threadId, limit);

    const run = thread.activeRunId === null ? null : await runById(ctx, thread.activeRunId);
    const activeRun =
      run === null || isFinalStatus(run.status)
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
          };

    const pending = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) =>
        q
          .eq("threadId", thread.threadId)
          .eq("kind", "page")
          .gt("createdAt", Date.now() - PAGE_ACTION_TTL_MS),
      )
      .take(50);
    const pageActions = pending.flatMap((call) =>
      call.claimedAt === null && call.name !== null && call.argumentsJson !== null
        ? [
            {
              toolCallId: call.toolCallId,
              runId: call.runId,
              name: call.name,
              argumentsJson: call.argumentsJson,
              created_at: isoTime(call.createdAt),
            },
          ]
        : [],
    );

    return {
      id: thread.threadId,
      agentId: thread.agentId,
      messages,
      hasMore,
      activeRun,
      latestRun,
      pageActions,
    };
  },
});

/** Stops the thread's run, if one is going. True when there was one to stop. */
export const cancel = mutation({
  args: { threadId: v.string(), owner: v.string(), api: vApi },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await threadById(ctx, args.threadId);
    if (thread === null || thread.owner !== args.owner || thread.activeRunId === null) {
      return false;
    }
    const run = await runById(ctx, thread.activeRunId);
    if (run === null || isFinalStatus(run.status)) return false;
    if (!run.cancelRequested) await ctx.db.patch(run._id, { cancelRequested: true });
    // Not sent yet: the start call sees the request and never sends it.
    if (!run.accepted) return true;
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
 * and revokes its live tokens. Irreversible. True when there was one to delete.
 */
export const remove = mutation({
  args: { threadId: v.string(), owner: v.string(), api: vApi },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await threadById(ctx, args.threadId);
    if (thread === null || thread.owner !== args.owner) return false;
    await ctx.db.delete(thread._id);
    await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId: thread.threadId });
    await ctx.scheduler.runAfter(0, internal.hercules.deleteThread, {
      threadId: thread.threadId,
      api: args.api,
      attempt: 0,
    });
    return true;
  },
});

const PURGE_BATCH = 200;

/** Deletes a removed thread's rows, a batch at a time. */
export const purge = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    let left = PURGE_BATCH;
    const batches = [
      ctx.db.query("message_chunks").withIndex("by_thread", (q) => q.eq("threadId", threadId)),
      ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadId)),
      ctx.db.query("tool_calls").withIndex("by_thread", (q) => q.eq("threadId", threadId)),
      ctx.db.query("runs").withIndex("by_thread", (q) => q.eq("threadId", threadId)),
    ];
    for (const rows of batches) {
      if (left === 0) break;
      for (const row of await rows.take(left)) {
        await ctx.db.delete(row._id);
        left--;
      }
    }
    if (left === 0) await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId });
    return null;
  },
});

/**
 * Takes a page action for one tab to run. True for the first tab to ask,
 * false for every other and for a page action whose moment has passed. A tab
 * reading the live stream may claim it before Hercules delivers it.
 */
export const claimPageAction = mutation({
  args: {
    threadId: v.string(),
    owner: v.string(),
    runId: v.string(),
    toolCallId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await threadById(ctx, args.threadId);
    if (thread === null || thread.owner !== args.owner) return false;
    const run = await runById(ctx, args.runId);
    if (run === null || run.threadId !== thread.threadId) return false;
    if (args.toolCallId.length > 200) return false;
    const now = Date.now();
    const call = await ctx.db
      .query("tool_calls")
      .withIndex("by_tool_call", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();
    if (call !== null) {
      if (call.runId !== run.runId || call.kind !== "page" || call.claimedAt !== null) {
        return false;
      }
      if (call.createdAt <= now - PAGE_ACTION_TTL_MS) return false;
      await ctx.db.patch(call._id, { claimedAt: now });
      return true;
    }
    if (run.finishedAt !== null && run.finishedAt <= now - PAGE_ACTION_TTL_MS) return false;
    await ctx.db.insert("tool_calls", {
      toolCallId: args.toolCallId,
      threadId: thread.threadId,
      runId: run.runId,
      name: null,
      kind: "page",
      status: "sent",
      summary: null,
      resultJson: null,
      argumentsJson: null,
      claimedAt: now,
      createdAt: now,
    });
    return true;
  },
});
