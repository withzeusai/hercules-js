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
    /** The Hercules thread id, a UUID this component picks. */
    threadId: v.string(),
    agentId: v.string(),
    /** `user:<tokenIdentifier>`, `visitor:<anonymousId>` or `app`. */
    owner: v.string(),
    activeRunId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_thread_id", ["threadId"])
    .index("by_owner", ["owner", "agentId", "updatedAt"]),

  runs: defineTable({
    /** The Hercules run id, a UUID this component picks. Also the idempotency key. */
    runId: v.string(),
    threadId: v.string(),
    agentId: v.string(),
    owner: v.string(),
    endUser: v.union(vEndUser, v.null()),
    status: vRunStatus,
    /** The request, kept so a retry sends the same body. */
    input: v.string(),
    context: v.optional(v.any()),
    pageActions: v.optional(v.array(v.string())),
    output: v.union(v.string(), v.null()),
    error: v.union(vRunError, v.null()),
    cappedReason: v.union(vCappedReason, v.null()),
    usage: v.union(vUsage, v.null()),
    progress: v.union(v.string(), v.null()),
    liveUrl: v.union(v.string(), v.null()),
    liveToken: v.union(v.string(), v.null()),
    /** Hercules accepted the run. */
    accepted: v.boolean(),
    cancelRequested: v.boolean(),
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

  tool_calls: defineTable({
    toolCallId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    /** Null only on a page action a tab claimed from the live stream before it was delivered. */
    name: v.union(v.string(), v.null()),
    kind: vToolKind,
    status: v.union(vToolCallStatus, v.null()),
    summary: v.union(v.string(), v.null()),
    /** An app tool's result, as JSON text. */
    resultJson: v.union(v.string(), v.null()),
    /** A page action's arguments, as JSON text. */
    argumentsJson: v.union(v.string(), v.null()),
    /** When a tab took the page action to run it. */
    claimedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_tool_call", ["toolCallId"])
    .index("by_thread", ["threadId", "kind", "createdAt"]),
});
