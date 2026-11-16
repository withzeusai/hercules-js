/**
 * A Hercules run as TanStack AI reads it: the run's live events as AG-UI
 * chunks, and a Convex thread as TanStack `UIMessage`s. These shapes exist
 * only here, in the browser; Hercules and Convex never see them.
 *
 * Every tool call gets its result in the stream, page actions included (with
 * "sent to the page"). An AG-UI client runs a tool call that a run leaves
 * unanswered and starts a new run with its result, which a Hercules run must
 * never get: its page actions are one-way.
 */
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai/client";
import type { AgentThread, ThreadMessage } from "./agents";
import {
  isFinalEvent,
  isFinalStatus,
  type AgentEvent,
  type CappedReason,
  type MessagePart,
  type RunError,
  type ToolCallStatus,
  type ToolKind,
} from "./component/protocol";

/** What a page action reports as its result: it went to the page, and the run carried on. */
export const PAGE_ACTION_OUTPUT = "sent to the page";
/** The `CUSTOM` event a run's `run.progress` becomes, with `{ label }` as its value. */
export const PROGRESS_EVENT = "hercules.progress";

/** A tool call's `output`: what Hercules says of it. Arguments and results of `hercules` tools never leave Hercules. */
export interface HerculesToolOutput {
  kind: ToolKind;
  status: ToolCallStatus;
  summary: string | null;
}

/** `metadata.hercules` on every message this adapter writes. */
export interface HerculesMessageMetadata {
  runId: string;
  /** On a hydrated message: where Convex has it. On a streamed one, after the run: how the run ended. */
  status?: string;
}

/** How a run ended, as its final event says. */
export type RunEnding =
  | { status: "completed" | "cancelled" }
  | { status: "capped"; cappedReason: CappedReason | null }
  | { status: "failed"; error: RunError };

export function toolOutput(
  kind: ToolKind,
  status: ToolCallStatus,
  summary: string | null,
): HerculesToolOutput | string {
  return kind === "page" ? PAGE_ACTION_OUTPUT : { kind, status, summary };
}

const TOOL_FAILED_TEXT = "Tool execution failed";

/** What a message holds, in order: a stretch of text, or a tool call by its id. */
type Piece = { text: string } | { toolCallId: string };

/** A message's parts as pieces: text parts with no tool call between them are one stretch. */
function piecesOf(parts: readonly MessagePart[]): Piece[] {
  const pieces: Piece[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      pieces.push({ toolCallId: part.id });
      continue;
    }
    if (part.text.length === 0) continue;
    const last = pieces[pieces.length - 1];
    if (last !== undefined && "text" in last) last.text += part.text;
    else pieces.push({ text: part.text });
  }
  return pieces;
}

/**
 * Whether a chat that shows `sent` can be brought to `whole` by adding to
 * it: `sent` is how `whole` begins, with at most its last stretch of text
 * still unfinished.
 */
function canExtendTo(sent: readonly Piece[], whole: readonly Piece[]): boolean {
  if (sent.length > whole.length) return false;
  return sent.every((piece, index) => {
    const target = whole[index] as Piece;
    if ("toolCallId" in piece)
      return "toolCallId" in target && target.toolCallId === piece.toolCallId;
    if (!("text" in target)) return false;
    return index === sent.length - 1
      ? target.text.startsWith(piece.text)
      : target.text === piece.text;
  });
}

interface MessageState {
  id: string;
  deltaText: string;
  appendedText: string;
  /** The text sent to TanStack so far. */
  emitted: string;
  /** What TanStack shows of the message so far, in order. */
  sent: Piece[];
  /** TEXT_MESSAGE_START sent. */
  open: boolean;
  /** TEXT_MESSAGE_END sent: nothing more goes into it. */
  closed: boolean;
  /** A tool call came after its last text, so more text starts a new text part. */
  toolSinceText: boolean;
}

interface ToolCallState {
  id: string;
  name: string;
  kind: ToolKind;
  ended: boolean;
  answered: boolean;
}

export interface RunChunksOptions {
  /**
   * The thread as Convex has it now. It is what the chat is rebuilt from
   * when a completed message differs from what was streamed of it.
   */
  thread?: () => AgentThread | null | undefined;
}

/**
 * One run's events, turned into AG-UI chunks as they arrive. Starts with
 * RUN_STARTED, and `finish()` ends it with exactly one RUN_FINISHED or
 * RUN_ERROR. Text is sent once: `message.delta` and `message.appended` carry
 * the same reply, so only what goes past the text already sent is written.
 *
 * A completed message is the truth. A step Hercules retried streams its text
 * a second time, so the chat can show more than the message holds, and an
 * AG-UI stream can only add to a message. When a completed message is not
 * what was streamed plus more, the chat's messages are replaced, with a
 * MESSAGES_SNAPSHOT of the thread holding the message as it completed.
 */
export class RunChunks {
  readonly threadId: string;
  readonly runId: string;
  /** How the run ended, once its final event (or Convex) says so. */
  ending: RunEnding | null = null;
  private lastSeq = 0;
  private finished = false;
  private readonly messages = new Map<string, MessageState>();
  private readonly toolCalls = new Map<string, ToolCallState>();
  /** The run's replies that completed, as they completed. */
  private readonly completed = new Map<string, ThreadMessage>();
  /** The message the stream wrote last: tool calls belong to it. */
  private current: MessageState | null = null;
  /** Tool calls that started before the stream named a message: the next one's first parts. */
  private unowned: Piece[] = [];
  private readonly thread: (() => AgentThread | null | undefined) | undefined;

  constructor(threadId: string, runId: string, options: RunChunksOptions = {}) {
    this.threadId = threadId;
    this.runId = runId;
    this.thread = options.thread;
  }

  private metadata(status?: string): { hercules: HerculesMessageMetadata } {
    return { hercules: { runId: this.runId, ...(status !== undefined && { status }) } };
  }

  started(): StreamChunk {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId: this.runId,
      timestamp: Date.now(),
    };
  }

  private message(id: string): MessageState {
    let message = this.messages.get(id);
    if (message === undefined) {
      message = {
        id,
        deltaText: "",
        appendedText: "",
        emitted: "",
        sent: [],
        open: false,
        closed: false,
        toolSinceText: false,
      };
      this.messages.set(id, message);
    }
    return message;
  }

  /** Sends what `text`, the message's text so far, has past what was sent. */
  private write(message: MessageState, text: string): StreamChunk[] {
    if (message.closed) return [];
    this.current = message;
    // Both are the start of the same reply; one that is not is not this reply.
    if (text.length <= message.emitted.length || !text.startsWith(message.emitted)) return [];
    const delta = text.slice(message.emitted.length);
    message.emitted = text;
    this.adopt(message);
    const last = message.sent[message.sent.length - 1];
    if (last !== undefined && "text" in last) last.text += delta;
    else message.sent.push({ text: delta });
    const chunks: StreamChunk[] = [];
    if (!message.open || message.toolSinceText) {
      // A second START for the same message opens a new text part after its tool calls.
      chunks.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: message.id,
        role: "assistant",
        metadata: this.metadata(),
        timestamp: Date.now(),
      });
      message.open = true;
      message.toolSinceText = false;
    }
    chunks.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: message.id,
      delta,
      timestamp: Date.now(),
    });
    return chunks;
  }

  /** Counts the tool calls that came before a message's first content as its first parts. */
  private adopt(message: MessageState): void {
    if (message.sent.length > 0 || this.unowned.length === 0) return;
    message.sent.push(...this.unowned);
    this.unowned = [];
  }

  private close(message: MessageState): StreamChunk[] {
    if (message.closed) return [];
    message.closed = true;
    if (this.current === message) this.current = null;
    return message.open
      ? [{ type: EventType.TEXT_MESSAGE_END, messageId: message.id, timestamp: Date.now() }]
      : [];
  }

  private startToolCall(
    id: string,
    name: string,
    kind: ToolKind,
    parent: MessageState | null,
  ): StreamChunk[] {
    if (this.toolCalls.has(id)) return [];
    this.toolCalls.set(id, { id, name, kind, ended: false, answered: false });
    const owner = parent ?? this.current;
    if (owner === null) {
      this.unowned.push({ toolCallId: id });
    } else {
      this.adopt(owner);
      owner.toolSinceText = true;
      owner.sent.push({ toolCallId: id });
    }
    return [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: name,
        ...(owner !== null && { parentMessageId: owner.id }),
        timestamp: Date.now(),
      },
    ];
  }

  private answer(
    id: string,
    name: string,
    kind: ToolKind,
    status: ToolCallStatus,
    summary: string | null,
    parent: MessageState | null,
    args?: unknown,
  ): StreamChunk[] {
    const chunks = this.startToolCall(id, name, kind, parent);
    const call = this.toolCalls.get(id) as ToolCallState;
    if (call.answered) return chunks;
    if (!call.ended) {
      if (args !== undefined) {
        chunks.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: id,
          delta: JSON.stringify(args) ?? "{}",
          timestamp: Date.now(),
        });
      }
      chunks.push({ type: EventType.TOOL_CALL_END, toolCallId: id, timestamp: Date.now() });
      call.ended = true;
    }
    call.answered = true;
    chunks.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${id}:result`,
      toolCallId: id,
      content: JSON.stringify(toolOutput(call.kind, status, summary)),
      role: "tool",
      // TanStack marks the call `error` for this.
      ...(status === "failed" && { metadata: { tanstack: { state: "output-error" } } }),
      timestamp: Date.now(),
    });
    return chunks;
  }

  /**
   * The chat's messages, replaced: the thread as `thread` has it, with this
   * run's completed replies as they completed. Null when it cannot be built:
   * no thread is at hand, or the thread holds older messages than it lists,
   * which the chat may show and a snapshot would drop.
   */
  private replace(thread: AgentThread | null | undefined): StreamChunk[] | null {
    if (thread === null || thread === undefined || thread.hasMore) return null;
    const messages = thread.messages.map((message) => this.completed.get(message.id) ?? message);
    const listed = new Set(messages.map((message) => message.id));
    for (const message of this.completed.values()) {
      if (!listed.has(message.id)) messages.push(message);
    }
    // The snapshot holds every tool call with its answer, and no message is open after it.
    for (const message of this.messages.values()) {
      if (this.completed.has(message.id)) message.closed = true;
    }
    for (const call of this.toolCalls.values()) {
      call.ended = true;
      call.answered = true;
    }
    this.current = null;
    const chunks: StreamChunk[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        // TanStack takes its own `UIMessage`s in a snapshot as they are.
        messages: threadToUIMessages({ ...thread, messages }) as never,
        timestamp: Date.now(),
      },
      // A snapshot makes TanStack forget the run it is reading and which
      // messages are the run's. Naming both again lets it put the run's end
      // on the reply, where it would otherwise add an empty message for it.
      this.started(),
    ];
    for (const message of this.completed.values()) {
      chunks.push(
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: message.id,
          role: "assistant",
          metadata: this.metadata(),
          timestamp: Date.now(),
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: message.id, timestamp: Date.now() },
      );
    }
    return chunks;
  }

  /**
   * A message as it stands in full. Sends what of it was not sent, in part
   * order, then ends it. When what was sent is not how it begins, replaces
   * the chat's messages instead, from `thread`.
   */
  private complete(
    id: string,
    parts: readonly MessagePart[],
    createdAt: string,
    thread: AgentThread | null | undefined,
  ): StreamChunk[] {
    const message = this.message(id);
    if (message.closed) return [];
    this.completed.set(id, {
      id,
      thread_id: this.threadId,
      run_id: this.runId,
      role: "assistant",
      parts: [...parts],
      created_at: createdAt,
      status: "completed",
    });
    this.adopt(message);
    // A tool call still to be answered must be the last thing sent: its answer
    // is added at the end, and text sent after it would start over behind it.
    const answersInPlace = message.sent.every(
      (piece, index) =>
        !("toolCallId" in piece) ||
        index === message.sent.length - 1 ||
        this.toolCalls.get(piece.toolCallId)?.answered === true,
    );
    if (!answersInPlace || !canExtendTo(message.sent, piecesOf(parts))) {
      const replaced = this.replace(thread);
      if (replaced !== null) return replaced;
      // Nothing to rebuild from: what can be added is, and `useThreadSync` has the rest.
    }
    const chunks: StreamChunk[] = [];
    let text = "";
    for (const part of parts) {
      if (part.type === "text") {
        text += part.text;
        chunks.push(...this.write(message, text));
      } else {
        chunks.push(
          ...this.answer(part.id, part.name, part.kind, part.status, part.summary, message),
        );
      }
    }
    chunks.push(...this.close(message));
    return chunks;
  }

  /**
   * Turns one event into chunks. An event already seen, or another run's,
   * gives none. A run's ending and a completed message are taken whatever
   * their sequence number: Hercules can number the ending of a run it had to
   * end itself at or below an event already streamed.
   */
  apply(event: AgentEvent): StreamChunk[] {
    if (this.finished || event.run_id !== this.runId) return [];
    const always = isFinalEvent(event) || event.type === "message.completed";
    if (event.seq <= this.lastSeq && !always) return [];
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    switch (event.type) {
      case "message.delta": {
        const message = this.message(event.data.message_id);
        message.deltaText += event.data.text;
        return this.write(message, longer(message.deltaText, message.appendedText));
      }
      case "message.appended": {
        const message = this.message(event.data.message_id);
        message.appendedText += event.data.text;
        return this.write(message, longer(message.deltaText, message.appendedText));
      }
      case "message.completed": {
        const completed = event.data.message;
        // The user's own message is on the page already.
        if (completed.role !== "assistant") return [];
        return this.complete(
          completed.id,
          completed.parts,
          completed.created_at || event.created_at,
          this.thread?.(),
        );
      }
      case "tool_call.started":
        return this.startToolCall(event.data.tool_call_id, event.data.name, event.data.kind, null);
      case "tool_call.completed": {
        const { tool_call_id: id, name, kind, status, summary } = event.data;
        if (kind === "page" && !this.toolCalls.get(id)?.answered) {
          // Answered with its arguments when its `page_action` event comes, or at the run's end.
          return this.startToolCall(id, name, kind, null);
        }
        return this.answer(id, name, kind, status, summary, null);
      }
      case "page_action": {
        const { tool_call_id: id, name } = event.data;
        return this.answer(id, name, "page", "sent", null, null, event.data.arguments ?? {});
      }
      case "run.progress":
        return [
          {
            type: EventType.CUSTOM,
            name: PROGRESS_EVENT,
            value: { label: event.data.label },
            timestamp: Date.now(),
          },
        ];
      case "run.completed":
        this.ending = { status: "completed" };
        return [];
      case "run.cancelled":
        this.ending = { status: "cancelled" };
        return [];
      case "run.capped":
        this.ending = { status: "capped", cappedReason: event.data.capped_reason };
        return [];
      case "run.failed":
        this.ending = { status: "failed", error: event.data.error };
        return [];
      default:
        return [];
    }
  }

  /**
   * Catches up from the thread as Convex has it, for what the live stream
   * did not bring: the run's messages, and how it ended.
   */
  reconcile(thread: AgentThread | null | undefined): StreamChunk[] {
    if (this.finished || thread === null || thread === undefined) return [];
    const chunks: StreamChunk[] = [];
    for (const message of thread.messages) {
      if (message.run_id !== this.runId || message.role !== "assistant") continue;
      if (message.status === "streaming") {
        // Convex holds only the text of a message still being written.
        chunks.push(...this.write(this.message(message.id), textOf(message.parts)));
      } else {
        chunks.push(...this.complete(message.id, message.parts, message.created_at, thread));
      }
    }
    const latest = thread.latestRun;
    if (this.ending === null && latest?.id === this.runId && isFinalStatus(latest.status)) {
      this.ending =
        latest.status === "failed"
          ? {
              status: "failed",
              error: latest.error ?? { code: "run_failed", message: "The run failed." },
            }
          : latest.status === "capped"
            ? { status: "capped", cappedReason: latest.cappedReason }
            : { status: latest.status };
    }
    return chunks;
  }

  /**
   * Ends the run's stream: closes open messages, answers every tool call
   * still open, and sends the one RUN_FINISHED or RUN_ERROR.
   */
  finish(fallback?: RunEnding): StreamChunk[] {
    if (this.finished) return [];
    this.finished = true;
    const chunks: StreamChunk[] = [];
    for (const message of this.messages.values()) chunks.push(...this.close(message));
    for (const call of this.toolCalls.values()) {
      if (call.answered) continue;
      // A page action was sent once Hercules called it; any other call the run left unfinished.
      const status = call.kind === "page" ? "sent" : "failed";
      chunks.push(...this.answer(call.id, call.name, call.kind, status, null, null));
    }
    const ending = this.ending ??
      fallback ?? {
        status: "failed",
        error: { code: "run_failed", message: "The run ended without saying how." },
      };
    if (ending.status === "failed") {
      chunks.push({
        type: EventType.RUN_ERROR,
        threadId: this.threadId,
        runId: this.runId,
        message: ending.error.message,
        code: ending.error.code,
        metadata: this.metadata("failed"),
        timestamp: Date.now(),
      });
    } else {
      chunks.push({
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId: this.runId,
        finishReason: "stop",
        outcome: ending.status === "cancelled" ? { type: "cancelled" } : { type: "success" },
        metadata: this.metadata(ending.status),
        timestamp: Date.now(),
      });
    }
    return chunks;
  }
}

/**
 * The RUN_ERROR for a message that was not sent: TanStack puts `code` on
 * `chat.error`, which a thrown error would lose.
 */
export function notSentChunk(
  threadId: string,
  runId: string,
  error: { code: string; message: string },
): StreamChunk {
  return {
    type: EventType.RUN_ERROR,
    threadId,
    runId,
    message: error.message,
    code: error.code,
    timestamp: Date.now(),
  };
}

/** The `code` on an error the chat shows, as Hercules or the app's agent functions named it. */
export function agentErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function longer(a: string, b: string): string {
  return a.length >= b.length ? a : b;
}

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

type UIPart = UIMessage["parts"][number];

function uiParts(message: ThreadMessage): UIPart[] {
  const parts: UIPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.length > 0) parts.push({ type: "text", content: part.text });
      continue;
    }
    const failed = part.status === "failed";
    const output = toolOutput(part.kind, part.status, part.summary);
    parts.push({
      type: "tool-call",
      id: part.id,
      name: part.name,
      arguments: "",
      state: failed ? "error" : "complete",
      output,
    });
    parts.push({
      type: "tool-result",
      toolCallId: part.id,
      content: JSON.stringify(output),
      state: failed ? "error" : "complete",
      ...(failed && { error: TOOL_FAILED_TEXT }),
    });
  }
  return parts;
}

/**
 * A thread's messages as TanStack `UIMessage`s, oldest first: the shape the
 * live stream builds, so a reload shows what streaming showed. Page action
 * arguments are not kept with the messages, so a reloaded page action has
 * none.
 */
export function threadToUIMessages(thread: AgentThread | null | undefined): UIMessage[] {
  if (thread === null || thread === undefined) return [];
  const messages: UIMessage[] = [];
  for (const message of thread.messages) {
    const parts = uiParts(message);
    // A reply that has not written anything yet is not shown.
    if (parts.length === 0 && message.role === "assistant") continue;
    const createdAt = new Date(message.created_at);
    messages.push({
      id: message.id,
      role: message.role,
      parts,
      ...(!Number.isNaN(createdAt.getTime()) && { createdAt }),
      metadata: { hercules: { runId: message.run_id, status: message.status } },
    });
  }
  return messages;
}

/** The run a TanStack message belongs to, when this adapter wrote it. */
export function runIdOf(message: { metadata?: Record<string, any> | undefined }): string | null {
  const runId: unknown = message.metadata?.["hercules"]?.runId;
  return typeof runId === "string" ? runId : null;
}

/**
 * What a reader sees of a transcript: roles, text, and each tool call's
 * name, state and output. Two transcripts that read the same need no update.
 */
export function transcriptKey(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
): string {
  return JSON.stringify(
    messages.map((message) => [
      message.role,
      message.parts.flatMap((part) => {
        const p = part as { type?: unknown } & Record<string, unknown>;
        if (p.type === "text") return [["text", p["content"]]];
        if (p.type === "tool-call") return [["tool", p["id"], p["name"], p["state"], p["output"]]];
        return [];
      }),
    ]),
  );
}
