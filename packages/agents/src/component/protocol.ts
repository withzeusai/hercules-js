/**
 * The Hercules agents API as it reaches an app: the objects and events of
 * `https://api.hercules.app/v1/agents`, version `2025-12-09`. Names are the
 * wire's, snake_case. No Convex imports, so the browser code can share it.
 *
 * The API only ever adds: unknown event types, part types and fields are
 * ignored, never refused.
 */

/** The API version every request sends as `Hercules-Version`. */
export const HERCULES_API_VERSION = "2025-12-09";
export const DEFAULT_API_URL = "https://api.hercules.app";
/** Where Hercules delivers a run's durable events in an app. Part of the contract. */
export const EVENTS_PATH = "/hercules/agents/events";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "capped";
export type FinalRunStatus = Exclude<RunStatus, "queued" | "running">;
export type CappedReason = "steps" | "time" | "credits" | "output";

export interface RunError {
  code: string;
  message: string;
}

export interface Usage {
  credits: number;
}

export interface Run {
  id: string;
  thread_id: string;
  agent_id: string;
  status: RunStatus;
  output: string | null;
  error: RunError | null;
  capped_reason: CappedReason | null;
  /** Null while the run is going. */
  usage: Usage | null;
  created_at: string;
  finished_at: string | null;
}

export type ToolKind = "hercules" | "app" | "page";
export type ToolCallStatus = "succeeded" | "failed" | "sent";

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * A tool the agent called. Arguments and results of `hercules` tools never
 * leave Hercules, so every kind carries only a `summary`.
 */
export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  kind: ToolKind;
  /** `sent` is a page action: it went to the page and the run carried on. */
  status: ToolCallStatus;
  summary: string | null;
}

/** More part types may be added. This package keeps the ones it knows. */
export type MessagePart = TextPart | ToolCallPart;

export interface Message {
  id: string;
  thread_id: string;
  run_id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  created_at: string;
}

export interface EventDataByType {
  "run.queued": Record<string, never>;
  "run.started": Record<string, never>;
  /** Live only: never delivered, only streamed. */
  "message.delta": { message_id: string; text: string };
  /** Best effort: the text since the last checkpoint. `message.completed` supersedes it. */
  "message.appended": { message_id: string; text: string };
  "message.completed": { message: Message };
  /** Live only. */
  "tool_call.started": { tool_call_id: string; name: string; kind: ToolKind };
  "tool_call.completed": {
    tool_call_id: string;
    name: string;
    kind: ToolKind;
    status: ToolCallStatus;
    summary: string | null;
    /** Only for `app` tools. */
    result?: unknown;
  };
  page_action: { tool_call_id: string; name: string; arguments: unknown };
  "run.progress": { label: string };
  "run.completed": { output: string | null; usage: Usage | null };
  "run.failed": { error: RunError; usage: Usage | null };
  "run.cancelled": { usage: Usage | null };
  "run.capped": { capped_reason: CappedReason; output: string | null; usage: Usage | null };
}

export type AgentEventType = keyof EventDataByType;

/**
 * One event of a run. `seq` starts at 1 and counts every event of the run,
 * durable or not, so the delivered ones have gaps. `id` is `<run_id>:<seq>`.
 */
export type AgentEvent = {
  [Type in AgentEventType]: {
    id: string;
    seq: number;
    run_id: string;
    thread_id: string;
    type: Type;
    created_at: string;
    data: EventDataByType[Type];
  };
}[AgentEventType];

export type AgentEventOf<Type extends AgentEventType> = Extract<AgentEvent, { type: Type }>;

/**
 * What a page is shown of a `hercules` tool call unless the app sets
 * `exposeToolDetails`: this name, and one of these summaries. Hercules writes
 * the same into the run's live stream, so the live and the stored views agree.
 */
export const HIDDEN_TOOL_NAME = "tool";
export const HIDDEN_TOOL_SUMMARY = "Used a tool";
export const HIDDEN_TOOL_FAILED_SUMMARY = "Couldn't use a tool";

/** A message part as a page may see it when tool details are not exposed. */
export function hideToolDetails(part: MessagePart): MessagePart {
  if (part.type !== "tool_call" || part.kind !== "hercules") return part;
  return {
    ...part,
    name: HIDDEN_TOOL_NAME,
    summary: part.status === "failed" ? HIDDEN_TOOL_FAILED_SUMMARY : HIDDEN_TOOL_SUMMARY,
  };
}

/** A page action is run only while its event is younger than this. Part of the contract. */
export const PAGE_ACTION_TTL_MS = 2 * 60 * 1000;

/** How long after it arrived a page action no tab ran stays listed on its thread. */
export const PAGE_ACTION_LISTED_MS = 10 * 60 * 1000;

/** Whether a page action whose event was written at `createdAt` may still be run at `nowMs`. */
export function isPageActionFresh(createdAt: string | number, nowMs: number): boolean {
  const at = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  // A time that cannot be read is not known to be recent.
  return Number.isFinite(at) && nowMs - at < PAGE_ACTION_TTL_MS;
}

/** The API's limit on a run's input text plus its context, in characters. */
export const MAX_INPUT_CHARS = 262_144;

/**
 * A run's input as Hercules measures it against `MAX_INPUT_CHARS`: the text,
 * then the context as indented JSON inside a `page_context` block.
 */
export function runInputText(text: string, context: Record<string, unknown> | undefined): string {
  if (context === undefined || Object.keys(context).length === 0) return text;
  return `${text}\n\n<page_context>\n${JSON.stringify(context, null, 2)}\n</page_context>`;
}

/**
 * Whether `url` may be given the app key: https, or http to this machine for
 * local development.
 */
export function isSafeApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return parsed.protocol === "http:" && local;
}

/** Every run ends with exactly one of these. */
export const FINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.capped",
] as const;

export function isFinalStatus(status: RunStatus): status is FinalRunStatus {
  return status !== "queued" && status !== "running";
}

export function isFinalEvent(event: { type: string }): boolean {
  return (FINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}

// Reading the wire. Everything below takes JSON that came over the network
// and keeps only the fields this package knows, in the types it expects, so
// what it returns is also a valid Convex value.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/** A summary is a line for a person to read; a longer one is cut. */
const MAX_SUMMARY_CHARS = 4000;

function summaryOf(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_SUMMARY_CHARS) : null;
}

const TOOL_KINDS: readonly string[] = ["hercules", "app", "page"];
const TOOL_CALL_STATUSES: readonly string[] = ["succeeded", "failed", "sent"];
const RUN_STATUSES: readonly string[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "capped",
];
const CAPPED_REASONS: readonly string[] = ["steps", "time", "credits", "output"];

function readToolKind(value: unknown): ToolKind | null {
  return typeof value === "string" && TOOL_KINDS.includes(value) ? (value as ToolKind) : null;
}

export function readUsage(value: unknown): Usage | null {
  if (!isRecord(value) || typeof value["credits"] !== "number") return null;
  return { credits: value["credits"] };
}

export function readRunError(value: unknown): RunError | null {
  if (!isRecord(value)) return null;
  const code = stringOr(value["code"], null);
  if (code === null) return null;
  return { code, message: stringOr(value["message"], code) };
}

export function readCappedReason(value: unknown): CappedReason | null {
  return typeof value === "string" && CAPPED_REASONS.includes(value)
    ? (value as CappedReason)
    : null;
}

export function readPart(value: unknown): MessagePart | null {
  if (!isRecord(value)) return null;
  if (value["type"] === "text") {
    const text = stringOr(value["text"], null);
    return text === null ? null : { type: "text", text };
  }
  if (value["type"] === "tool_call") {
    const id = stringOr(value["id"], null);
    const name = stringOr(value["name"], null);
    const kind = readToolKind(value["kind"]);
    const status = value["status"];
    if (id === null || name === null || kind === null) return null;
    if (typeof status !== "string" || !TOOL_CALL_STATUSES.includes(status)) return null;
    return {
      type: "tool_call",
      id,
      name,
      kind,
      status: status as ToolCallStatus,
      summary: summaryOf(value["summary"]),
    };
  }
  return null;
}

export function readMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null;
  const id = stringOr(value["id"], null);
  const threadId = stringOr(value["thread_id"], null);
  const runId = stringOr(value["run_id"], null);
  const role = value["role"];
  if (id === null || threadId === null || runId === null) return null;
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(value["parts"]) ? value["parts"] : [];
  return {
    id,
    thread_id: threadId,
    run_id: runId,
    role,
    parts: parts.map(readPart).filter((part): part is MessagePart => part !== null),
    created_at: stringOr(value["created_at"], ""),
  };
}

export function readRun(value: unknown): Run | null {
  if (!isRecord(value)) return null;
  const id = stringOr(value["id"], null);
  const status = value["status"];
  if (id === null || typeof status !== "string" || !RUN_STATUSES.includes(status)) return null;
  return {
    id,
    thread_id: stringOr(value["thread_id"], ""),
    agent_id: stringOr(value["agent_id"], ""),
    status: status as RunStatus,
    output: stringOr(value["output"], null),
    error: readRunError(value["error"]),
    capped_reason: readCappedReason(value["capped_reason"]),
    usage: readUsage(value["usage"]),
    created_at: stringOr(value["created_at"], ""),
    finished_at: stringOr(value["finished_at"], null),
  };
}

/** JSON text for a value of any shape, or null when it cannot be written as JSON. */
function toJsonText(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * An event as this package stores and passes it between functions. Tool
 * results and page action arguments are arbitrary JSON, which Convex cannot
 * always hold (a `$ref` key, say), so they travel as JSON text.
 */
export interface WireEvent {
  runId: string;
  threadId: string;
  seq: number;
  type: string;
  createdAt: string;
  data: WireEventData;
}

export type WireEventData =
  | { kind: "none" }
  | { kind: "text"; messageId: string; text: string }
  | { kind: "message"; message: Message }
  | {
      kind: "tool_call";
      toolCallId: string;
      name: string;
      toolKind: ToolKind;
      status: ToolCallStatus | null;
      summary: string | null;
      resultJson: string | null;
    }
  | { kind: "page_action"; toolCallId: string; name: string; argumentsJson: string }
  | { kind: "progress"; label: string }
  | {
      kind: "final";
      status: FinalRunStatus;
      output: string | null;
      error: RunError | null;
      cappedReason: CappedReason | null;
      usage: Usage | null;
    };

const FINAL_STATUS_BY_TYPE: Record<string, FinalRunStatus> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.capped": "capped",
};

function readEventData(type: string, data: Record<string, unknown>): WireEventData | null {
  switch (type) {
    case "message.delta":
    case "message.appended": {
      const messageId = stringOr(data["message_id"], null);
      const text = stringOr(data["text"], null);
      return messageId === null || text === null ? null : { kind: "text", messageId, text };
    }
    case "message.completed": {
      const message = readMessage(data["message"]);
      return message === null ? null : { kind: "message", message };
    }
    case "tool_call.started":
    case "tool_call.completed": {
      const toolCallId = stringOr(data["tool_call_id"], null);
      const name = stringOr(data["name"], null);
      const toolKind = readToolKind(data["kind"]);
      if (toolCallId === null || name === null || toolKind === null) return null;
      const status = data["status"];
      return {
        kind: "tool_call",
        toolCallId,
        name,
        toolKind,
        status:
          typeof status === "string" && TOOL_CALL_STATUSES.includes(status)
            ? (status as ToolCallStatus)
            : null,
        summary: summaryOf(data["summary"]),
        resultJson: toolKind === "app" ? toJsonText(data["result"]) : null,
      };
    }
    case "page_action": {
      const toolCallId = stringOr(data["tool_call_id"], null);
      const name = stringOr(data["name"], null);
      if (toolCallId === null || name === null) return null;
      return {
        kind: "page_action",
        toolCallId,
        name,
        argumentsJson: toJsonText(data["arguments"]) ?? "{}",
      };
    }
    case "run.progress": {
      const label = stringOr(data["label"], null);
      return label === null ? null : { kind: "progress", label };
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.capped": {
      const status = FINAL_STATUS_BY_TYPE[type] as FinalRunStatus;
      return {
        kind: "final",
        status,
        output: stringOr(data["output"], null),
        error:
          status === "failed"
            ? (readRunError(data["error"]) ?? { code: "run_failed", message: "The run failed." })
            : null,
        cappedReason: status === "capped" ? readCappedReason(data["capped_reason"]) : null,
        usage: readUsage(data["usage"]),
      };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * Reads one event off the wire. Returns null for an envelope without a run,
 * a sequence number and a type: nothing can be done with it. An event whose
 * type this package does not know keeps its place in the sequence with no data.
 */
export function readWireEvent(value: unknown): WireEvent | null {
  if (!isRecord(value)) return null;
  const runId = stringOr(value["run_id"], null);
  const seq = value["seq"];
  const type = stringOr(value["type"], null);
  if (runId === null || type === null) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  const data = isRecord(value["data"]) ? value["data"] : {};
  return {
    runId,
    threadId: stringOr(value["thread_id"], ""),
    seq,
    type,
    createdAt: stringOr(value["created_at"], ""),
    // Known type, unreadable data: keep the place in the sequence, drop the event.
    data: readEventData(type, data) ?? { kind: "none" },
  };
}

/**
 * Reads an event for the browser. Returns null for an envelope that cannot be
 * read, an event type this package does not know, or a known event whose
 * data is not the shape the contract gives it.
 */
export function readAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null;
  const wire = readWireEvent(value);
  if (wire === null) return null;
  const known = wire.type === "run.queued" || wire.type === "run.started";
  if (wire.data.kind === "none" && !known) return null;
  return {
    id: stringOr(value["id"], `${wire.runId}:${wire.seq}`),
    seq: wire.seq,
    run_id: wire.runId,
    thread_id: wire.threadId,
    type: wire.type,
    created_at: wire.createdAt,
    data: isRecord(value["data"]) ? value["data"] : {},
  } as AgentEvent;
}
