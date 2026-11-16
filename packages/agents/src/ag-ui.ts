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
    // The thread has moved on to a newer run (the app started a follow-up, or
    // another tab sent), so `latestRun` is not this run. This run is over,
    // and its reply is stored: that is a run that finished, not one to
    // report as failed for want of an ending.
    if (
      this.ending === null &&
      latest?.id !== this.runId &&
      thread.activeRun?.id !== this.runId &&
      thread.messages.some(
        (message) =>
          message.run_id === this.runId &&
          message.role === "assistant" &&
          message.status !== "streaming",
      )
    ) {
      this.ending = { status: "completed" };
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

/** What `metadata.hercules.status` says of a reply this page streamed and its run did not finish here. */
const CUT_OFF_STATUSES: ReadonlySet<unknown> = new Set([
  // Streamed until the page stopped the run: the stream never said how it ended.
  undefined,
  "incomplete",
  "cancelled",
  "failed",
]);

/** A message as the chat shows it: what `useChat` returns, read loosely. */
interface ShownMessage {
  id: string;
  role: string;
  parts: ReadonlyArray<unknown>;
  metadata?: Record<string, any> | undefined;
}

/**
 * Whether the chat shows something of the run `runId` that this page
 * streamed and the thread does not hold yet, so the thread's copy would take
 * some of it away.
 *
 * The run's id alone does not say so: a message put here from the thread (by
 * `hydrate`, or by an earlier sync of a run another tab started) carries it
 * too. `metadata.hercules.status` tells the two apart:
 *
 * - None: the live stream wrote the message, and has not said how the run
 *   ended.
 * - `streaming` or `incomplete`: where Convex has a message. Only a message
 *   read from the thread says that.
 * - `cancelled`, `capped` or `failed`: how a run ended. Only a message whose
 *   run's stream ended on this page says that.
 * - `completed` is said of both, so the thread decides: a message it holds
 *   as completed is its own, and one it does not is ahead of it.
 */
export function showsStreamOf(
  shown: ReadonlyArray<ShownMessage>,
  thread: AgentThread,
  runId: string,
): boolean {
  return shown.some((message) => {
    if (runIdOf(message) !== runId) return false;
    const status: unknown = message.metadata?.["hercules"]?.status;
    if (status === "streaming" || status === "incomplete") return false;
    if (status !== "completed") return true;
    return !thread.messages.some(
      (entry) => entry.id === message.id && entry.status === "completed",
    );
  });
}

function shownText(parts: ReadonlyArray<unknown>): string {
  return parts
    .map((part) => {
      const p = part as { type?: unknown; content?: unknown };
      return p.type === "text" && typeof p.content === "string" ? p.content : "";
    })
    .join("");
}

/** A tool call the stream started and never answered: its run ended first. */
function isUnansweredToolCall(part: unknown): boolean {
  const p = part as { type?: unknown; output?: unknown };
  return p.type === "tool-call" && p.output === undefined;
}

/**
 * `next`, the thread as Convex has it, with what this page streamed of a
 * reply its run's end cut off put back in.
 *
 * Hercules stores a reply's text in checkpoints. When a run is stopped while
 * it writes, the thread holds the reply up to its last checkpoint
 * (`incomplete`), or nothing of it, and the page has streamed further. The
 * page's copy is kept, marked `incomplete`, for as long as the page lives; a
 * reload shows what the thread has.
 *
 * Kept narrowly, because a completed reply in Convex is the truth: only the
 * last message the page shows of a run, only when that run did not finish
 * here with the reply whole, and only when the thread holds less of the same
 * reply (its text is how the page's begins) or none of it.
 */
export function keepCutOffReplies(
  shown: ReadonlyArray<ShownMessage>,
  next: UIMessage[],
  thread: AgentThread,
): UIMessage[] {
  const lastOfRun = new Map<string, ShownMessage>();
  for (const message of shown) {
    const runId = runIdOf(message);
    if (runId !== null) lastOfRun.set(runId, message);
  }
  let kept = next;
  for (const [runId, message] of lastOfRun) {
    if (message.role !== "assistant" || runId === thread.activeRun?.id) continue;
    if (!CUT_OFF_STATUSES.has(message.metadata?.["hercules"]?.status)) continue;
    const stored = thread.messages.filter((entry) => entry.run_id === runId);
    const last = stored[stored.length - 1];
    // A run older than the thread's window: its messages are not Convex's to replace.
    if (last === undefined) continue;
    const parts = message.parts.filter((part) => !isUnansweredToolCall(part));
    const text = shownText(parts);
    if (text.length === 0) continue;
    const cutOff = last.role === "assistant" && last.status === "incomplete" ? last : null;
    if (cutOff !== null) {
      const held = textOf(cutOff.parts);
      if (text.length <= held.length || !text.startsWith(held)) continue;
    } else if (
      // The thread has this reply, under its id or by its text.
      stored.some(
        (entry) =>
          entry.id === message.id ||
          (entry.role === "assistant" && textOf(entry.parts).startsWith(text)),
      )
    ) {
      continue;
    }
    const reply = {
      ...message,
      parts,
      metadata: { ...message.metadata, hercules: { runId, status: "incomplete" } },
    } as UIMessage;
    const replaced = cutOff === null ? -1 : kept.findIndex((entry) => entry.id === cutOff.id);
    if (replaced !== -1) {
      kept = [...kept.slice(0, replaced), reply, ...kept.slice(replaced + 1)];
      continue;
    }
    // After the run's last message in the thread: its input, or an earlier reply.
    let after = kept.length - 1;
    while (after >= 0 && runIdOf(kept[after] as UIMessage) !== runId) after--;
    if (after !== -1) kept = [...kept.slice(0, after + 1), reply, ...kept.slice(after + 1)];
  }
  return kept;
}

/**
 * What a reader sees of a transcript: roles, text, each tool call's name,
 * state and output, and whether a reply is marked as cut off. Two
 * transcripts that read the same need no update.
 */
export function transcriptKey(
  messages: ReadonlyArray<{
    role: string;
    parts: ReadonlyArray<unknown>;
    metadata?: Record<string, any> | undefined;
  }>,
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
      message.metadata?.["hercules"]?.status === "incomplete",
    ]),
  );
}
