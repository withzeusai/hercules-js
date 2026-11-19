/**
 * A thread as an app reads it: what `thread`, `readThread`,
 * `readThreadDetails` and the two hooks hand the app. The package builds
 * these objects, so their names are camelCase. No imports but the API's
 * types, so the browser entry points do not need Convex to read them.
 *
 * Where a field holds a value Hercules may add to (a status, a kind, a
 * reason, a part's type), its type is an open set: see `./api`. So is a
 * status the package defines itself: a later version may add a value.
 */
import type { CappedReason, MessagePart, RunStatus, ToolCallStatus, ToolKind } from "./api";

/**
 * A message of a thread, as the package builds it: `runId`, `createdAt`, and
 * a `status`. The API's own message, as an event carries it, is `Message`.
 */
export interface ThreadMessage {
  id: string;
  threadId: string;
  runId: string;
  /** An open set: skip a message whose role you do not know. */
  role: "user" | "assistant" | (string & {});
  /** Render the parts whose `type` you know and skip the rest. */
  parts: MessagePart[];
  createdAt: string;
  /**
   * `streaming` while the reply is being written, `completed` when it is
   * whole, `incomplete` when its run ended first. An open set: a later
   * version of the package may add a status. Show a message whose status you
   * do not know as it is, marked neither as being written nor as cut off.
   */
  status: "streaming" | "completed" | "incomplete" | (string & {});
}

/** The run that is going on a thread. */
export interface ActiveRun {
  id: string;
  /** An open set: any status but `queued` is a run that is going. */
  status: "queued" | "running" | (string & {});
  /** The run's latest progress label. */
  progress: string | null;
  /** Where the browser streams the reply from, with a read-only token for this run. */
  live: { url: string; token: string } | null;
  /** The last event sequence number the app has applied. */
  lastSeq: number;
  createdAt: string;
  /** A stop was asked for and the run has not ended yet. Until it has, `send` throws `thread_busy`. */
  stopping: boolean;
}

/** How a thread's latest run stands, going or not: it says why a reply is missing. */
export interface LatestRun {
  id: string;
  /** An open set: a status that is not `completed`, `failed`, `cancelled` or `capped` is a run still going. */
  status: RunStatus;
  /** `code` is any string. `retryAfterSeconds` counts from `finishedAt`. */
  error: { code: string; message: string; retryAfterSeconds?: number } | null;
  cappedReason: CappedReason | null;
  finishedAt: string | null;
}

/** A page action no tab has run yet. */
export interface PendingPageAction {
  toolCallId: string;
  runId: string;
  name: string;
  /** The arguments as JSON text. A model wrote them: untrusted input. */
  argumentsJson: string;
  /** When the agent called it. */
  createdAt: string;
  /**
   * `pending`: no tab has run it yet. `expired`: it came too late to be run,
   * and will not be. An open set: a later version of the package may add a
   * status. One you do not know is not the page's to run, and has not
   * expired.
   */
  status: "pending" | "expired" | (string & {});
}

/** The thread `thread` and `readThread` return. */
export interface AgentThread {
  id: string;
  agentId: string;
  /** Oldest first: the thread's newest messages. */
  messages: ThreadMessage[];
  /** True when older messages were left out. */
  hasMore: boolean;
  activeRun: ActiveRun | null;
  latestRun: LatestRun | null;
  pageActions: PendingPageAction[];
}

/** A tool call as the component stores it, for the app's own backend. */
export interface StoredToolCall {
  toolCallId: string;
  runId: string;
  name: string;
  kind: ToolKind;
  status: ToolCallStatus | null;
  summary: string | null;
  /** An app tool's result as JSON text. Null for the other kinds. */
  resultJson: string | null;
  /** A page action's arguments as JSON text. */
  argumentsJson: string | null;
  createdAt: string;
}

/** What `readThreadDetails` returns: the thread as stored, with its tool calls and their results. */
export interface AgentThreadDetails extends AgentThread {
  /** The tool calls of the runs whose messages are listed, oldest first. */
  toolCalls: StoredToolCall[];
  /** True when the results came to more than one read holds: the older runs' calls are left out. */
  toolCallsTruncated: boolean;
}
