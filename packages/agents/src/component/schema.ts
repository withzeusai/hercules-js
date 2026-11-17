import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vCappedReason,
  vEndUser,
  vMessagePart,
  vMessageStatus,
  vRunError,
  vRunStatus,
  vToolCallStatus,
  vToolKind,
  vUsage,
} from "./validators.js";

export default defineSchema({
  threads: defineTable({
    /** The Hercules thread id: a UUID this component picks, or the UUID or ULID the page chose. */
    threadId: v.string(),
    agentId: v.string(),
    /** `user:<tokenIdentifier>` or `app`. */
    owner: v.string(),
    activeRunId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_thread_id", ["threadId"])
    .index("by_owner", ["owner", "agentId", "updatedAt"]),

  /**
   * One row per deleted thread: what is still to be done about it. The
   * thread's own row is gone at once. Its other rows are purged in batches,
   * and Hercules is asked to delete its copy until it says it has, so both
   * are tracked here, where a tick that cannot be lost comes back to them.
   *
   * The row is kept for good, and retires the thread's id. A page may choose
   * a thread's id, so without it a page could open a new thread under a
   * deleted one's: the purge of the old rows, and Hercules's own delete,
   * would then take the new thread's.
   */
  deleted_threads: defineTable({
    threadId: v.string(),
    deletedAt: v.number(),
    /** When the thread's last row here was purged. */
    purgedAt: v.union(v.number(), v.null()),
    /**
     * When Hercules confirmed its copy is gone (it deleted it, or has none).
     * Set at once, with nothing asked, for a thread Hercules never took a run
     * on: Hercules has no thread of this caller's under the id.
     */
    remoteDeletedAt: v.union(v.number(), v.null()),
    /** When asking Hercules was given up: after a day, or on an answer that cannot change. */
    remoteGaveUpAt: v.union(v.number(), v.null()),
    /**
     * When Hercules first answered 404 to the delete, or for the run it is
     * asked for first (`unconfirmedRunId`). It answers 404 on every route
     * while the agents API is off for the app, so a 404 counts as "gone"
     * only once it has been the answer for an hour.
     */
    remoteMissingSince: v.union(v.number(), v.null()),
    /** How many times Hercules was asked, and the earliest time to ask again. */
    attempts: v.number(),
    nextAttemptAt: v.number(),
    /** When a purge batch last ran. The purge is started again only when this is stale. */
    purgeProgressAt: v.number(),
    /**
     * The run whose start Hercules had not answered when the thread was
     * deleted, when it had taken none of the thread's runs before. Hercules
     * is asked to delete the thread only once it says it has this run: that
     * is what tells the thread there is this caller's. Left out when Hercules
     * had taken a run of the thread, and on rows written before the field
     * was added.
     */
    unconfirmedRunId: v.optional(v.string()),
  }).index("by_thread_id", ["threadId"]),

  /**
   * One row per run. Every delivered batch rewrites it, so it holds only
   * small fields: the request is in `run_requests`.
   */
  runs: defineTable({
    /** The Hercules run id, a UUID this component picks. Also the idempotency key. */
    runId: v.string(),
    threadId: v.string(),
    agentId: v.string(),
    owner: v.string(),
    endUser: v.union(vEndUser, v.null()),
    status: vRunStatus,
    /** The app's `exposeToolDetails` when the run was sent, so a retry sends the same. */
    exposeToolDetails: v.boolean(),
    output: v.union(v.string(), v.null()),
    error: v.union(vRunError, v.null()),
    cappedReason: v.union(vCappedReason, v.null()),
    usage: v.union(vUsage, v.null()),
    progress: v.union(v.string(), v.null()),
    liveUrl: v.union(v.string(), v.null()),
    /** The run's read-only token. Cleared an hour after the run ends, when it expires. */
    liveToken: v.union(v.string(), v.null()),
    /** Hercules has the run: it answered the start call, or delivered one of its events. */
    accepted: v.boolean(),
    cancelRequested: v.boolean(),
    /** When the start call's next try is due. Null when none is scheduled. */
    nextStartAt: v.union(v.number(), v.null()),
    /** When Hercules first answered that it has no such run. Null once it answers otherwise. */
    missingSince: v.union(v.number(), v.null()),
    /**
     * How many stuck-run checks in a row found the run still going at
     * Hercules. Each doubles the wait for the next. Any delivered event
     * resets it.
     */
    quietChecks: v.number(),
    /** The highest event sequence number applied. Events at or below it are duplicates. */
    lastSeq: v.number(),
    /** When an event was last applied, or the run was created. The stuck-run check reads it. */
    lastEventAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
    /** A function handle into the app, called once the run's last write is done. */
    onRunFinished: v.union(v.string(), v.null()),
  })
    .index("by_run_id", ["runId"])
    .index("by_thread", ["threadId"])
    .index("by_owner", ["owner", "agentId"]),

  /**
   * The start of a run that was purged with its thread while it still counted
   * toward its user's hourly limit. `send` counts these with the `runs` rows,
   * so deleting a thread does not give its runs back. One small row per such
   * run, dropped when the run's hour is up. The app's own runs have no limit
   * and leave none.
   */
  purged_run_starts: defineTable({
    owner: v.string(),
    agentId: v.string(),
    /** When the run was sent: its `runs` row's creation time. */
    startedAt: v.number(),
  }).index("by_owner", ["owner", "agentId", "startedAt"]),

  /** What a run was started with, kept so a retried start sends the same body. */
  run_requests: defineTable({
    runId: v.string(),
    threadId: v.string(),
    input: v.string(),
    context: v.optional(v.any()),
    pageActions: v.optional(v.array(v.string())),
  })
    .index("by_run_id", ["runId"])
    .index("by_thread", ["threadId"]),

  /**
   * One row per message, or several for a message too large for one document:
   * `segment` counts them and the reader joins them back.
   */
  messages: defineTable({
    messageId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    status: vMessageStatus,
    parts: v.array(vMessagePart),
    segment: v.number(),
    /** The first part continues the previous segment's last text part. */
    continuesText: v.boolean(),
    createdAt: v.string(),
    /** Sort keys: the run's creation time, then the first event that named the message. */
    runOrder: v.number(),
    firstSeq: v.number(),
  })
    .index("by_message", ["messageId", "segment"])
    .index("by_thread", ["threadId", "runOrder", "firstSeq", "segment"])
    .index("by_run", ["runId"]),

  /** Text of a reply still being written, from `message.appended`. Merged on completion. */
  message_chunks: defineTable({
    messageId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    seq: v.number(),
    text: v.string(),
  })
    .index("by_message", ["messageId", "seq"])
    .index("by_thread", ["threadId"]),

  /** The tool calls Hercules delivered, as delivered. A row exists only for a call a run made. */
  tool_calls: defineTable({
    toolCallId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    name: v.string(),
    kind: vToolKind,
    status: v.union(vToolCallStatus, v.null()),
    summary: v.union(v.string(), v.null()),
    /** An app tool's result, as JSON text. */
    resultJson: v.union(v.string(), v.null()),
    /** A page action's arguments, as JSON text. */
    argumentsJson: v.union(v.string(), v.null()),
    /** When a tab took the page action to run it. */
    claimedAt: v.union(v.number(), v.null()),
    /** A tab asked for the page action after its two minutes: it will not be run. */
    expired: v.boolean(),
    /** When Hercules wrote the call's first event: the event's own time, not its arrival. */
    createdAt: v.number(),
  })
    .index("by_run", ["runId", "toolCallId"])
    // Read by arrival (`_creationTime`), which every index ends with.
    .index("by_thread", ["threadId", "kind"]),
});
