/**
 * The Hercules agents API as it reaches an app: the objects and events of
 * `https://api.hercules.app/v1/agents`, version `2025-12-09`. Names are the
 * wire's, snake_case. No Convex imports, so the browser code can share it.
 *
 * The API only ever adds: new event types, fields, statuses, part types and
 * error codes arrive without a new version. So everything read here ignores
 * what it does not know and never throws over it:
 *
 * - An event of an unknown type keeps its place in the sequence and changes
 *   nothing. One Hercules marks as a run's ending (`final: true`) ends the run.
 * - A field it does not know is not read. A message part of an unknown type
 *   is left out, and the parts beside it are kept.
 * - A tool call of an unknown kind reads as a `hercules` tool call, the kind
 *   whose details a page is not shown. One that ended with an unknown status
 *   reads as `failed`: it is not known to have worked.
 * - A `capped_reason` it does not know reads as null, and an error code is
 *   any string.
 */

/** The API version every request sends as `Hercules-Version`. */
export const HERCULES_API_VERSION = "2025-12-09";

// The build writes the package's version here, from `package.json`: see
// `tsdown.config.ts`. It is never written by hand.
declare const __HERCULES_AGENTS_VERSION__: string | undefined;

/** This package's version, as `package.json` has it. */
export const PACKAGE_VERSION: string =
  typeof __HERCULES_AGENTS_VERSION__ === "string" ? __HERCULES_AGENTS_VERSION__ : "unknown";

/**
 * The header that says which client, and which version of it, makes a
 * request: `Hercules-Client: agents/<version>`. Hercules reads it to know
 * which versions of the package are in use. It is a header of its own, not
 * `User-Agent`, because a runtime may set or drop that one itself, and a
 * browser does not let a page set it at all.
 */
export const CLIENT_HEADER = "hercules-client";
export const CLIENT_ID = `agents/${PACKAGE_VERSION}`;

export const DEFAULT_API_URL = "https://api.hercules.app";
/** Where Hercules delivers a run's durable events in an app. Part of the contract. */
export const EVENTS_PATH = "/hercules/agents/events";

/**
 * The statuses this version knows. A run ends with one of the four in
 * `FinalRunStatus`. Every other status, `queued`, `running` or one added
 * later, is a run that is still going.
 */
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
  /** `capped_reason` is null for a reason this version does not know. */
  "run.capped": {
    capped_reason: CappedReason | null;
    output: string | null;
    usage: Usage | null;
  };
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

/**
 * The header that names the end user a request is made for, on every
 * request about a user's thread or run: `Hercules-End-User: <tokenIdentifier>`,
 * the same `<issuer>|<subject>` a run is started with as
 * `end_user.token_identifier`. Left out for the app's own threads.
 */
export const END_USER_HEADER = "hercules-end-user";

/** What a header can carry as it is: visible ASCII, with spaces only inside. */
const HEADER_SAFE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const ENCODED_PREFIX = "UTF-8''";
/** Half of a surrogate pair with no other half: it has no UTF-8 of its own. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A user's `tokenIdentifier` as the `Hercules-End-User` header carries it.
 * As it is when it is visible ASCII, which an identifier made of an issuer's
 * URL and a subject is as a rule. One that a header cannot carry (a subject
 * with other characters) is sent as `UTF-8''` followed by its percent-encoded
 * UTF-8, the form RFC 8187 gives such values: a request must never fail to
 * be sent over who it is for.
 */
export function endUserHeaderValue(tokenIdentifier: string): string {
  if (HEADER_SAFE.test(tokenIdentifier) && !tokenIdentifier.startsWith(ENCODED_PREFIX)) {
    return tokenIdentifier;
  }
  // A lone surrogate is sent as the replacement character, as UTF-8 encoders do.
  return `${ENCODED_PREFIX}${encodeURIComponent(tokenIdentifier.replace(LONE_SURROGATE, "\ufffd"))}`;
}
/** Every run ends with exactly one of these. */
export const FINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.capped",
] as const;

/** The statuses a run ends with. The list is closed: a status not on it is not an ending. */
export const FINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "capped"] as const;

/**
 * Whether `status` is one a run ends with. A status this version does not
 * know is not: the API may add statuses for a run that is still going, such
 * as one waiting for a person, and such a run must not read as over.
 */
export function isFinalStatus(status: string): status is FinalRunStatus {
  return (FINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * A run as read off the wire. `status` is whatever Hercules sent, known to
 * this version or not: see `isFinalStatus` and `hasRunEnded`.
 */
export interface WireRun extends Omit<Run, "status"> {
  status: string;
}

/**
 * Whether a run read from Hercules is over. It is when its status is a final
 * one. A run in a status this version does not know is over when it carries
 * `finished_at`, which Hercules sets only on a run that ended: that is how an
 * ending added after this version was built is told from a run that is still
 * going. `queued` and `running` are a run that is going, whatever else it
 * carries.
 */
export function hasRunEnded(run: WireRun): boolean {
  if (isFinalStatus(run.status)) return true;
  if (run.status === "queued" || run.status === "running") return false;
  return run.finished_at !== null;
}

/**
 * The status this package keeps for a run that is going at Hercules. A
 * status it does not know reads as `running`: Hercules has the run, and it
 * is not over.
 */
export function goingStatus(status: string): "queued" | "running" {
  return status === "queued" ? "queued" : "running";
}

/**
 * Whether an event ends its run: one of the four final types, or an event of
 * any other type that Hercules marks with `final: true`. No type added so far
 * carries the mark. It is read so that an ending added later is still an
 * ending to this version.
 */
export function isFinalEvent(event: { type: string; final?: unknown }): boolean {
  return (FINAL_EVENT_TYPES as readonly string[]).includes(event.type) || event.final === true;
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
/** An error code is a short name; a longer one is cut. */
const MAX_CODE_CHARS = 256;

function summaryOf(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_SUMMARY_CHARS) : null;
}

const TOOL_KINDS: readonly string[] = ["hercules", "app", "page"];
const TOOL_CALL_STATUSES: readonly string[] = ["succeeded", "failed", "sent"];
const CAPPED_REASONS: readonly string[] = ["steps", "time", "credits", "output"];

/**
 * A tool call's kind. One this version does not know reads as `hercules`:
 * not the app's tool and not a page action, and the kind whose name and
 * summary a page is not shown unless the app set `exposeToolDetails`.
 */
function readToolKind(value: unknown): ToolKind | null {
  if (typeof value !== "string") return null;
  return TOOL_KINDS.includes(value) ? (value as ToolKind) : "hercules";
}

/**
 * How a tool call ended. A status this version does not know reads as
 * `failed`: the call is over and is not known to have worked.
 */
function readEndedStatus(value: unknown): ToolCallStatus | null {
  if (typeof value !== "string") return null;
  return TOOL_CALL_STATUSES.includes(value) ? (value as ToolCallStatus) : "failed";
}

export function readUsage(value: unknown): Usage | null {
  if (!isRecord(value) || typeof value["credits"] !== "number") return null;
  return { credits: value["credits"] };
}

export function readRunError(value: unknown): RunError | null {
  if (!isRecord(value)) return null;
  const code = stringOr(value["code"], null);
  if (code === null) return null;
  // Any code is taken, one this version does not know among them.
  return {
    code: code.slice(0, MAX_CODE_CHARS),
    message: stringOr(value["message"], code).slice(0, MAX_SUMMARY_CHARS),
  };
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
    const status = readEndedStatus(value["status"]);
    if (id === null || name === null || kind === null || status === null) return null;
    return { type: "tool_call", id, name, kind, status, summary: summaryOf(value["summary"]) };
  }
  // A part type added later: left out, and the parts beside it are kept.
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

/**
 * Reads a run. Null only for a body without an id and a status. A status
 * this version does not know is kept as it came, so the run can be told
 * apart from one that could not be read.
 */
export function readRun(value: unknown): WireRun | null {
  if (!isRecord(value)) return null;
  const id = stringOr(value["id"], null);
  const status = stringOr(value["status"], null);
  if (id === null || status === null) return null;
  return {
    id,
    thread_id: stringOr(value["thread_id"], ""),
    agent_id: stringOr(value["agent_id"], ""),
    status,
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

function readEventData(
  type: string,
  data: Record<string, unknown>,
  /** Hercules marked the event as its run's ending. */
  markedFinal: boolean,
): WireEventData | null {
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
      return {
        kind: "tool_call",
        toolCallId,
        name,
        toolKind,
        // Only a call that completed says how it ended.
        status: type === "tool_call.completed" ? readEndedStatus(data["status"]) : null,
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
      return label === null ? null : { kind: "progress", label: label.slice(0, MAX_SUMMARY_CHARS) };
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
      if (!markedFinal) return { kind: "none" };
      // An ending of a type added after this version was built. The run is
      // over, and this version cannot say how: it is recorded as failed, with
      // the event's own error when it carries one, and keeps what it wrote.
      return {
        kind: "final",
        status: "failed",
        output: stringOr(data["output"], null),
        error: readRunError(data["error"]) ?? {
          code: "run_failed",
          message: `The run ended with the event ${JSON.stringify(type.slice(0, 64))}, which this version of @usehercules/agents does not know. Upgrade the package to read it.`,
        },
        cappedReason: null,
        usage: readUsage(data["usage"]),
      };
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
    data: readEventData(type, data, value["final"] === true) ?? { kind: "none" },
  };
}

/**
 * A known event's data for the browser: the fields this version knows, read
 * as `readWireEvent` reads them, over whatever else the event carried. Null
 * for an event that is not one of the known types.
 */
function agentEventData(
  type: string,
  wire: WireEventData,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (wire.kind) {
    case "none":
      return type === "run.queued" || type === "run.started" ? raw : null;
    case "text":
      return { ...raw, message_id: wire.messageId, text: wire.text };
    case "message":
      return { ...raw, message: wire.message };
    case "tool_call":
      if (type === "tool_call.started") {
        return { ...raw, tool_call_id: wire.toolCallId, name: wire.name, kind: wire.toolKind };
      }
      return {
        ...raw,
        tool_call_id: wire.toolCallId,
        name: wire.name,
        kind: wire.toolKind,
        // The call is over. With no status this version knows, it is not known to have worked.
        status: wire.status ?? "failed",
        summary: wire.summary,
      };
    case "page_action":
      return { ...raw, tool_call_id: wire.toolCallId, name: wire.name };
    case "progress":
      return { ...raw, label: wire.label };
    case "final":
      switch (type) {
        case "run.completed":
          return { ...raw, output: wire.output, usage: wire.usage };
        case "run.failed":
          return { ...raw, error: wire.error, usage: wire.usage };
        case "run.cancelled":
          return { ...raw, usage: wire.usage };
        case "run.capped":
          return {
            ...raw,
            capped_reason: wire.cappedReason,
            output: wire.output,
            usage: wire.usage,
          };
        default:
          // An ending of a type added later: `followRun` ends on it without passing it on.
          return null;
      }
  }
}

/**
 * Reads an event for the browser. Returns null for an envelope that cannot be
 * read, an event type this package does not know, or a known event whose
 * data is not the shape the contract gives it.
 *
 * What it returns can be relied on: the fields this version knows are of the
 * types it declares, an unknown tool kind, tool status or capped reason is
 * read as the header of this file says, and a completed message holds only
 * parts of the types this version knows. Fields it does not know are passed
 * on as they came.
 */
export function readAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null;
  const wire = readWireEvent(value);
  if (wire === null) return null;
  const data = agentEventData(wire.type, wire.data, isRecord(value["data"]) ? value["data"] : {});
  if (data === null) return null;
  return {
    id: stringOr(value["id"], `${wire.runId}:${wire.seq}`),
    seq: wire.seq,
    run_id: wire.runId,
    thread_id: wire.threadId,
    type: wire.type,
    created_at: wire.createdAt,
    data,
  } as AgentEvent;
}
