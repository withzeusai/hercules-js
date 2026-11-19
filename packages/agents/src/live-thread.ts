/**
 * What the browser shows of a thread: the messages Convex holds, with the
 * reply being written laid over them from the run's live stream until its
 * `message.completed` lands in Convex. No React here, so it is tested alone.
 */
import type { AgentThread, ThreadMessage } from "./agents";
import {
  isFinalEvent,
  type AgentEvent,
  type Message,
  type ToolCallPart,
  type ToolCallStatus,
  type ToolKind,
} from "./component/protocol";

/** A tool call as the page shows it: `running` until the live stream says how it went. */
export interface ViewToolCallPart extends Omit<ToolCallPart, "status"> {
  status: ToolCallStatus | "running";
}

export type ViewPart = { type: "text"; text: string } | ViewToolCallPart;

export interface ViewMessage extends Omit<ThreadMessage, "parts" | "status"> {
  parts: ViewPart[];
  /** `pending` is the user's message on its way to Convex. */
  status: ThreadMessage["status"] | "pending";
}

interface LiveMessage {
  id: string;
  createdAt: string;
  /** Text from `message.delta`. */
  deltaText: string;
  /** Text from `message.appended`, for a stream that no longer has the deltas. */
  appendedText: string;
  toolCalls: ViewToolCallPart[];
  completed: Message | null;
}

/** One run's live stream, folded into messages. */
export class LiveRun {
  readonly runId: string;
  readonly threadId: string;
  lastSeq = 0;
  finished = false;
  private readonly messages = new Map<string, LiveMessage>();
  /** The message tool calls attach to: the latest one the stream named. */
  private current: LiveMessage | null = null;

  constructor(runId: string, threadId: string) {
    this.runId = runId;
    this.threadId = threadId;
  }

  private message(id: string, createdAt: string): LiveMessage {
    let message = this.messages.get(id);
    if (message === undefined) {
      message = { id, createdAt, deltaText: "", appendedText: "", toolCalls: [], completed: null };
      this.messages.set(id, message);
    }
    return message;
  }

  private toolCallHolder(createdAt: string): LiveMessage {
    return this.current ?? this.message(`${this.runId}:tools`, createdAt);
  }

  private findToolCall(id: string): ViewToolCallPart | undefined {
    for (const message of this.messages.values()) {
      const call = message.toolCalls.find((entry) => entry.id === id);
      if (call !== undefined) return call;
    }
    return undefined;
  }

  private addToolCall(createdAt: string, call: ViewToolCallPart) {
    const existing = this.findToolCall(call.id);
    if (existing !== undefined) {
      existing.status = call.status;
      existing.summary = call.summary ?? existing.summary;
      return;
    }
    this.toolCallHolder(createdAt).toolCalls.push(call);
  }

  /**
   * Folds in one event. Returns false for one already seen. A run's ending
   * and a completed message are taken whatever their sequence number:
   * Hercules can number them at or below an event already streamed.
   */
  apply(event: AgentEvent): boolean {
    if (event.run_id !== this.runId) return false;
    const always = isFinalEvent(event) || event.type === "message.completed";
    if (event.seq <= this.lastSeq && !always) return false;
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    switch (event.type) {
      case "message.delta": {
        const message = this.message(event.data.message_id, event.created_at);
        message.deltaText += event.data.text;
        this.current = message;
        break;
      }
      case "message.appended": {
        const message = this.message(event.data.message_id, event.created_at);
        message.appendedText += event.data.text;
        this.current = message;
        break;
      }
      case "message.completed": {
        const completed = event.data.message;
        const message = this.message(completed.id, completed.created_at || event.created_at);
        message.completed = completed;
        // Tool calls the completed message lists are its own now.
        const listed = new Set(
          completed.parts.flatMap((part) => (part.type === "tool_call" ? [part.id] : [])),
        );
        for (const other of this.messages.values()) {
          if (other !== message) other.toolCalls = other.toolCalls.filter((c) => !listed.has(c.id));
        }
        if (completed.role === "assistant") this.current = null;
        break;
      }
      case "tool_call.started":
        this.addToolCall(event.created_at, {
          type: "tool_call",
          id: event.data.tool_call_id,
          name: event.data.name,
          kind: event.data.kind as ToolKind,
          status: "running",
          summary: null,
        });
        break;
      case "tool_call.completed":
        this.addToolCall(event.created_at, {
          type: "tool_call",
          id: event.data.tool_call_id,
          name: event.data.name,
          kind: event.data.kind,
          status: event.data.status,
          summary: event.data.summary,
        });
        break;
      case "page_action":
        this.addToolCall(event.created_at, {
          type: "tool_call",
          id: event.data.tool_call_id,
          name: event.data.name,
          kind: "page",
          status: "sent",
          summary: null,
        });
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.capped":
        this.finished = true;
        break;
      default:
        break;
    }
    return true;
  }

  /** The run's messages as the stream has them, in the order it named them. */
  view(storedText: (id: string) => string): ViewMessage[] {
    const views: ViewMessage[] = [];
    for (const message of this.messages.values()) {
      if (message.completed !== null) {
        // The user's own message is already shown, from Convex or as pending.
        if (message.completed.role === "assistant") {
          // The API's message, under the names the thread gives its messages.
          views.push({
            id: message.completed.id,
            threadId: message.completed.thread_id,
            runId: message.completed.run_id,
            role: message.completed.role,
            parts: message.completed.parts,
            createdAt: message.completed.created_at,
            status: "completed",
          });
        }
        continue;
      }
      const live =
        message.deltaText.length >= message.appendedText.length
          ? message.deltaText
          : message.appendedText;
      const stored = storedText(message.id);
      // Both are the start of the same reply, so the longer one is further along.
      const text = live.length >= stored.length ? live : stored;
      const parts: ViewPart[] = [
        ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
        ...message.toolCalls.map((call) => ({ ...call })),
      ];
      if (parts.length === 0) continue;
      views.push({
        id: message.id,
        threadId: this.threadId,
        runId: this.runId,
        role: "assistant",
        parts,
        createdAt: message.createdAt,
        status: "streaming",
      });
    }
    return views;
  }

  hasContent(): boolean {
    return this.view(() => "").length > 0;
  }
}

/** A message the user sent that Convex does not show yet. */
export interface PendingInput {
  key: string;
  text: string;
  /** Known once `send` returns. */
  runId: string | null;
  createdAt: string;
}

function textOf(message: { parts: readonly ViewPart[] }): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * The messages to show: Convex's, with the live run laid over the replies
 * it is still writing, then what the stream has that Convex does not yet.
 * The overlay applies only while Convex still has that run going.
 */
export function mergeThread(
  thread: AgentThread | null | undefined,
  live: LiveRun | null,
  pending: readonly PendingInput[],
): ViewMessage[] {
  const stored: ViewMessage[] = thread?.messages.map((message) => ({ ...message })) ?? [];
  const overlay = live !== null && thread?.activeRun?.id === live.runId ? live : null;

  const sentRuns = new Set(stored.flatMap((m) => (m.role === "user" ? [m.runId] : [])));
  const waiting: ViewMessage[] = pending
    .filter((input) => input.runId === null || !sentRuns.has(input.runId))
    .map((input) => ({
      id: input.key,
      threadId: thread?.id ?? "",
      runId: input.runId ?? "",
      role: "user",
      parts: [{ type: "text", text: input.text }],
      createdAt: input.createdAt,
      status: "pending",
    }));

  if (overlay === null) return [...stored, ...waiting];

  const byId = new Map(stored.map((message, index) => [message.id, index]));
  const liveViews = overlay.view((id) => {
    const index = byId.get(id);
    return index === undefined ? "" : textOf(stored[index] as ViewMessage);
  });
  const extra: ViewMessage[] = [];
  for (const view of liveViews) {
    const index = byId.get(view.id);
    if (index === undefined) {
      extra.push(view);
      continue;
    }
    // Convex has the finished message: it is the one to show.
    if ((stored[index] as ViewMessage).status !== "streaming") continue;
    stored[index] = view;
  }
  return [...stored, ...waiting, ...extra];
}
