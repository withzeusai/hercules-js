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
export const vRunError = v.object({ code: v.string(), message: v.string() });
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
 * The end user a run acts for. Absent for the app's own runs.
 * `tokenIdentifier` is Convex's `<issuer>|<subject>` for a signed-in user.
 */
export const vEndUser = v.union(
  v.object({ tokenIdentifier: v.string() }),
  v.object({ anonymousId: v.string() }),
);
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

/** A message as `threads.read` returns it: the API's Message, plus where it stands. */
export const vThreadMessage = v.object({
  id: v.string(),
  thread_id: v.string(),
  run_id: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  parts: v.array(vMessagePart),
  created_at: v.string(),
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
  created_at: v.string(),
});

/** How the thread's latest run stands, going or not: it says why a reply is missing. */
export const vLatestRun = v.object({
  id: v.string(),
  status: vRunStatus,
  error: v.union(vRunError, v.null()),
  cappedReason: v.union(vCappedReason, v.null()),
});

export const vPendingPageAction = v.object({
  toolCallId: v.string(),
  runId: v.string(),
  name: v.string(),
  /** The arguments as JSON text. */
  argumentsJson: v.string(),
  created_at: v.string(),
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

export const vRunFinished = v.object({
  runId: v.string(),
  threadId: v.string(),
  agentId: v.string(),
  status: vFinalRunStatus,
  output: v.union(v.string(), v.null()),
  error: v.union(vRunError, v.null()),
  cappedReason: v.union(vCappedReason, v.null()),
  usage: v.union(vUsage, v.null()),
  endUser: v.union(vEndUser, v.null()),
});

/** What `onRunFinished` is called with, after the run's last write. */
export type RunFinished = Infer<typeof vRunFinished>;
