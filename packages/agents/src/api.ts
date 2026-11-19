/**
 * The Hercules agents API's own objects, as an app's code meets them: the
 * events `followRun` yields, with the message inside a `message.completed`,
 * and a run. They are the API's JSON, under the API's names (snake_case),
 * as the API reference documents them. No imports, so any entry point can
 * share these types.
 *
 * The API only ever adds: fields, event types, statuses, part types, kinds,
 * reasons and codes arrive without a new version. So every set of values
 * here is open. A set of plain strings takes any string beside the names
 * this version knows. A union told apart by a name (`type` on an event or a
 * part) has one more member for the names this version does not know, so no
 * `switch` over it is ever complete without a `default`.
 */

declare const unknownName: unique symbol;

/**
 * A name this version of the package does not know, where a union is told
 * apart by one: an event's `type`, a message part's `type`, a tool caller's
 * `principal`. It is what is left in the `default` branch once every name
 * this version knows has a `case`.
 *
 * At run time it is the string Hercules sent. Read it with `String(value)`:
 * TypeScript cannot compare it with a string directly.
 */
export interface UnknownName {
  readonly [unknownName]: true;
}

/** The statuses a run ends with. This list is closed: a run is over exactly when it has one. */
export type FinalRunStatus = "completed" | "failed" | "cancelled" | "capped";

/**
 * A run's status. An open set: every status that is not one of the four in
 * `FinalRunStatus`, one added later among them, is a run that is still going.
 */
export type RunStatus = "queued" | "running" | FinalRunStatus | (string & {});

/** Why a run was capped. An open set: read one you do not know as "a limit was reached". */
export type CappedReason = "steps" | "time" | "credits" | "output" | (string & {});

/**
 * Whose tool a call ran. An open set: read a kind you do not know as
 * `hercules`, a tool that is neither the app's nor a page action.
 */
export type ToolKind = "hercules" | "app" | "page" | (string & {});

/**
 * How a tool call ended. `sent` is a page action: it went to the page and
 * the run carried on. An open set: read a status you do not know as not
 * known to have worked.
 */
export type ToolCallStatus = "succeeded" | "failed" | "sent" | (string & {});

/** Why a run failed. `code` is an open set: any string, with `run_failed` the meaning of one you do not know. */
export interface RunError {
  code: string;
  message: string;
}

export interface Usage {
  credits: number;
}

/** A run as the Hercules API returns it: the API's own JSON, under the API's names. */
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
  status: ToolCallStatus;
  summary: string | null;
}

/** A part of a type this version of the package does not know. Skip it, and show the parts beside it. */
export interface UnknownPart {
  type: UnknownName;
}

/**
 * A part of a message. An open set: render the parts whose `type` you know
 * and skip the rest.
 */
export type MessagePart = TextPart | ToolCallPart | UnknownPart;

/**
 * A message as the Hercules API sends it, in a `message.completed` event:
 * the API's own JSON, under the API's names. A thread's message, which the
 * package builds from it, is `ThreadMessage`.
 */
export interface Message {
  id: string;
  thread_id: string;
  run_id: string;
  /** An open set: skip a message whose role you do not know. */
  role: "user" | "assistant" | (string & {});
  parts: MessagePart[];
  created_at: string;
}

/** What each event type this version knows carries in its `data`. */
export interface EventDataByType {
  "run.queued": Record<string, unknown>;
  "run.started": Record<string, unknown>;
  /** Live only: never delivered, only streamed. */
  "message.delta": { message_id: string; text: string };
  /** Best effort: the text written since the last one. `message.completed` supersedes it. */
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
    /** Only for `app` tools. The tool's own data: never renamed, never looked into. */
    result?: unknown;
  };
  /** `arguments` is what the model wrote: untrusted, never renamed, never looked into. */
  page_action: { tool_call_id: string; name: string; arguments: unknown };
  "run.progress": { label: string };
  "run.completed": { output: string | null; usage: Usage | null };
  "run.failed": { error: RunError; usage: Usage | null };
  "run.cancelled": { usage: Usage | null };
  "run.capped": {
    capped_reason: CappedReason | null;
    output: string | null;
    usage: Usage | null;
  };
}

/** The name of an event type. An open set: any string beside the ones this version knows. */
export type AgentEventType = keyof EventDataByType | (string & {});

interface EventEnvelope<Type, Data> {
  /** `<run_id>:<seq>`. */
  id: string;
  /** Starts at 1 and counts every event of the run, so the ones you get have gaps. */
  seq: number;
  run_id: string;
  thread_id: string;
  type: Type;
  created_at: string;
  /**
   * Whether this event ends its run: true on the run's final event, false
   * on every other. Check this, not `type`, to know a run is over: an
   * ending of a type added later is then still an ending.
   */
  final: boolean;
  data: Data;
}

/**
 * One event of a run, as the Hercules API sends it. Either an event of a
 * type this version knows, with its `data` typed, or one of a type it does
 * not know, which is what a `default` branch receives: `String(event.type)`
 * is its name, and `data` is whatever Hercules sent.
 *
 * `if (event.type === "message.delta")` narrows as usual. A `switch` over
 * `event.type` is never complete without a `default`.
 */
export type AgentEvent =
  | {
      [Type in keyof EventDataByType]: EventEnvelope<Type, EventDataByType[Type]>;
    }[keyof EventDataByType]
  | EventEnvelope<UnknownName, Record<string, unknown>>;

/** The event of one type this version knows. */
export type AgentEventOf<Type extends keyof EventDataByType> = Extract<AgentEvent, { type: Type }>;
