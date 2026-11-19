/** Convex validators for what the component stores and returns. */
import { v, type Infer } from "convex/values";

export const vRunStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("capped"),
);
export const vFinalRunStatus = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("capped"),
);
export const vCappedReason = v.union(
  v.literal("steps"),
  v.literal("time"),
  v.literal("credits"),
  v.literal("output"),
);
export const vToolKind = v.union(v.literal("hercules"), v.literal("app"), v.literal("page"));
export const vToolCallStatus = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("sent"),
);
/**
 * Why a run failed. `retryAfterSeconds` is set when Hercules refused the run
 * over a limit: how long, from when the run ended, until one may start.
 */
export const vRunError = v.object({
  code: v.string(),
  message: v.string(),
  retryAfterSeconds: v.optional(v.number()),
});
export type StoredRunError = Infer<typeof vRunError>;
export const vUsage = v.object({ credits: v.number() });

export const vTextPart = v.object({ type: v.literal("text"), text: v.string() });
export const vToolCallPart = v.object({
  type: v.literal("tool_call"),
  id: v.string(),
  name: v.string(),
  kind: vToolKind,
  status: vToolCallStatus,
  summary: v.union(v.string(), v.null()),
});
export const vMessagePart = v.union(vTextPart, vToolCallPart);

export const vMessage = v.object({
  id: v.string(),
  thread_id: v.string(),
  run_id: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  parts: v.array(vMessagePart),
  created_at: v.string(),
});

/**
 * The end user a run acts for: a signed-in user, by Convex's
 * `<issuer>|<subject>`. Absent for the app's own runs.
 */
export const vEndUser = v.object({ tokenIdentifier: v.string() });
export type EndUser = Infer<typeof vEndUser>;

/** How the component reaches Hercules. The key is the app's `HERCULES_API_KEY`. */
export const vApi = v.object({ url: v.string(), key: v.string() });
export type ApiConfig = Infer<typeof vApi>;

export const vWireEventData = v.union(
  v.object({ kind: v.literal("none") }),
  v.object({ kind: v.literal("text"), messageId: v.string(), text: v.string() }),
  v.object({ kind: v.literal("message"), message: vMessage }),
  v.object({
    kind: v.literal("tool_call"),
    toolCallId: v.string(),
    name: v.string(),
    toolKind: vToolKind,
    status: v.union(vToolCallStatus, v.null()),
    summary: v.union(v.string(), v.null()),
    resultJson: v.union(v.string(), v.null()),
  }),
  v.object({
    kind: v.literal("page_action"),
    toolCallId: v.string(),
    name: v.string(),
    argumentsJson: v.string(),
  }),
  v.object({ kind: v.literal("progress"), label: v.string() }),
  v.object({
    kind: v.literal("final"),
    status: vFinalRunStatus,
    output: v.union(v.string(), v.null()),
    error: v.union(vRunError, v.null()),
    cappedReason: v.union(vCappedReason, v.null()),
    usage: v.union(vUsage, v.null()),
  }),
);

export const vWireEvent = v.object({
  runId: v.string(),
  threadId: v.string(),
  seq: v.number(),
  type: v.string(),
  createdAt: v.string(),
  data: vWireEventData,
});

export const vMessageStatus = v.union(
  v.literal("streaming"),
  v.literal("completed"),
  v.literal("incomplete"),
);

/**
 * A message as `threads.read` returns it: the package's own shape, under
 * camelCase names, with where the message stands. The API's `Message`, which
 * `vMessage` above mirrors, keeps the API's names.
 */
export const vThreadMessage = v.object({
  id: v.string(),
  threadId: v.string(),
  runId: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  parts: v.array(vMessagePart),
  createdAt: v.string(),
  /** `streaming` while the reply is being written, `incomplete` when its run ended first. */
  status: vMessageStatus,
});

export const vActiveRun = v.object({
  id: v.string(),
  status: v.union(v.literal("queued"), v.literal("running")),
  /** The latest `run.progress` label. */
  progress: v.union(v.string(), v.null()),
  /** Where the browser streams the reply from, with a read-only token for this run. */
  live: v.union(v.object({ url: v.string(), token: v.string() }), v.null()),
  /** The last event sequence number this app has applied. */
  lastSeq: v.number(),
  createdAt: v.string(),
  /**
   * A stop was asked for (`cancel`) and the run has not ended yet. It ends
   * within a few seconds as a rule; until then a new message is refused as
   * `thread_busy`.
   */
  stopping: v.boolean(),
});

/** How the thread's latest run stands, going or not: it says why a reply is missing. */
export const vLatestRun = v.object({
  id: v.string(),
  status: vRunStatus,
  error: v.union(vRunError, v.null()),
  cappedReason: v.union(vCappedReason, v.null()),
  /** When the run ended. `error.retryAfterSeconds` counts from here. */
  finishedAt: v.union(v.string(), v.null()),
});

export const vPendingPageAction = v.object({
  toolCallId: v.string(),
  runId: v.string(),
  name: v.string(),
  /** The arguments as JSON text. */
  argumentsJson: v.string(),
  /** When the agent called it. A page action older than two minutes is not run. */
  createdAt: v.string(),
  /**
   * `pending`: waiting for a tab to claim and run it. `expired`: it reached
   * the app, or a tab, more than two minutes after the agent called it, so
   * it was not run and will not be. Listed for ten minutes, for the page to
   * say so.
   */
  status: v.union(v.literal("pending"), v.literal("expired")),
});

export const vThread = v.object({
  id: v.string(),
  agentId: v.string(),
  /** Oldest first: the latest `limit` messages. */
  messages: v.array(vThreadMessage),
  /** True when older messages were left out. */
  hasMore: v.boolean(),
  activeRun: v.union(vActiveRun, v.null()),
  latestRun: v.union(vLatestRun, v.null()),
  /** Page actions no tab has claimed yet. */
  pageActions: v.array(vPendingPageAction),
});

/** A tool call as the component stores it, for the app's own backend. */
export const vStoredToolCall = v.object({
  toolCallId: v.string(),
  runId: v.string(),
  name: v.string(),
  kind: vToolKind,
  status: v.union(vToolCallStatus, v.null()),
  summary: v.union(v.string(), v.null()),
  /** An app tool's result as JSON text. Null for the other kinds. */
  resultJson: v.union(v.string(), v.null()),
  /** A page action's arguments as JSON text. */
  argumentsJson: v.union(v.string(), v.null()),
  createdAt: v.string(),
});

/** What `threads.readDetails` returns: the thread as stored, with its tool calls. */
export const vThreadDetails = v.object({
  ...vThread.fields,
  /** The tool calls of the runs whose messages are listed, oldest first. */
  toolCalls: v.array(vStoredToolCall),
  /** True when the results came to more than one read holds: the older runs' calls are left out. */
  toolCallsTruncated: v.boolean(),
});

export const vRunFinished = v.object({
  runId: v.string(),
  threadId: v.string(),
  agentId: v.string(),
  status: vFinalRunStatus,
  output: v.union(v.string(), v.null()),
  error: v.union(vRunError, v.null()),
  // Any string: an app takes these fields as its function's arguments, and a
  // reason Hercules adds later must not be one its validator refuses.
  cappedReason: v.union(v.string(), v.null()),
  usage: v.union(vUsage, v.null()),
  endUser: v.union(vEndUser, v.null()),
});

/** What `onRunFinished` is called with, after the run's last write. */
export type RunFinished = Infer<typeof vRunFinished>;
