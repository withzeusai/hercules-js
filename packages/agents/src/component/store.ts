/** Reads and writes shared by the component's functions. No functions are registered here. */
import type { FunctionHandle } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  hideToolDetails,
  isFinalStatus,
  type CappedReason,
  type FinalRunStatus,
  type Message,
  type MessagePart,
  type Usage,
} from "./protocol.js";
import type { EndUser, RunFinished, StoredRunError } from "./validators.js";

/** A run with no event for this long is checked against Hercules directly. */
export const STUCK_AFTER_MS = 3 * 60 * 1000;
/** A run's token reads its events until this long after the run ends. */
export const LIVE_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Messages larger than this are stored in several documents (a document holds 1 MiB). */
export const SEGMENT_MAX_BYTES = 512 * 1024;
/** The longest run output and tool result kept. The full reply is in the messages. */
export const MAX_STORED_TEXT_BYTES = 256 * 1024;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 200;
/**
 * The most message text one read of a thread returns. A read stops at a
 * whole message once it is past this, and says there are older ones: a
 * Convex function may read 16 MiB.
 */
export const READ_BUDGET_BYTES = 4 * 1024 * 1024;

export const APP_OWNER = "app";

export function ownerOf(endUser: EndUser | null): string {
  return endUser === null ? APP_OWNER : `user:${endUser.tokenIdentifier}`;
}

/** A random UUID: the API takes ULIDs or UUIDs for run and thread ids. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte character.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Cuts text into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export function splitText(text: string, maxBytes: number): string[] {
  if (utf8Length(text) <= maxBytes) return [text];
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) {
      pieces.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    if (pair) i++;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/** Text cut to what is kept in a document. */
export function capText(text: string | null): string | null {
  if (text === null) return null;
  return splitText(text, MAX_STORED_TEXT_BYTES)[0] ?? "";
}

function partBytes(part: MessagePart): number {
  return utf8Length(JSON.stringify(part));
}

export interface Segment {
  parts: MessagePart[];
  continuesText: boolean;
}

/**
 * Packs a message's parts into segments of about `maxBytes` each. A text part
 * too large for one segment is cut, and the segment holding the rest says so.
 */
export function segmentParts(parts: MessagePart[], maxBytes = SEGMENT_MAX_BYTES): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { parts: [], continuesText: false };
  let size = 0;
  function close(continuesText: boolean) {
    segments.push(current);
    current = { parts: [], continuesText };
    size = 0;
  }
  for (const part of parts) {
    const bytes = partBytes(part);
    if (size + bytes <= maxBytes) {
      current.parts.push(part);
      size += bytes;
      continue;
    }
    if (part.type !== "text") {
      if (current.parts.length > 0) close(false);
      current.parts.push(part);
      size = bytes;
      continue;
    }
    // Room is left for the part's JSON wrapping.
    const pieces = splitText(part.text, maxBytes - 64);
    pieces.forEach((piece, index) => {
      const pieceBytes = utf8Length(piece) + 32;
      if (size + pieceBytes > maxBytes && current.parts.length > 0) close(index > 0);
      current.parts.push({ type: "text", text: piece });
      size += pieceBytes;
    });
  }
  if (current.parts.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}

/** Joins a message's segments back into its parts. */
export function joinSegments(segments: readonly Segment[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const segment of segments) {
    segment.parts.forEach((part, index) => {
      const previous = parts[parts.length - 1];
      if (
        index === 0 &&
        segment.continuesText &&
        part.type === "text" &&
        previous?.type === "text"
      ) {
        parts[parts.length - 1] = { type: "text", text: previous.text + part.text };
      } else {
        parts.push(part);
      }
    });
  }
  return parts;
}

export async function threadById(ctx: QueryCtx, threadId: string) {
  return await ctx.db
    .query("threads")
    .withIndex("by_thread_id", (q) => q.eq("threadId", threadId))
    .unique();
}

export async function runById(ctx: QueryCtx, runId: string) {
  return await ctx.db
    .query("runs")
    .withIndex("by_run_id", (q) => q.eq("runId", runId))
    .unique();
}

/** A run's tool call. Tool call ids are the run's own, so they are looked up by run. */
export async function toolCallById(ctx: QueryCtx, runId: string, toolCallId: string) {
  return await ctx.db
    .query("tool_calls")
    .withIndex("by_run", (q) => q.eq("runId", runId).eq("toolCallId", toolCallId))
    .unique();
}

async function messageRows(ctx: QueryCtx, messageId: string) {
  return await ctx.db
    .query("messages")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
}

async function deleteChunks(ctx: MutationCtx, messageId: string) {
  const chunks = await ctx.db
    .query("message_chunks")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  for (const chunk of chunks) await ctx.db.delete(chunk._id);
}

async function chunkText(ctx: QueryCtx, messageId: string): Promise<string> {
  const chunks = await ctx.db
    .query("message_chunks")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  return chunks.map((chunk) => chunk.text).join("");
}

/** The id of the user message `send` writes before Hercules has the run. */
export function inputMessageId(runId: string): string {
  return `${runId}:input`;
}

/**
 * Stores a message, replacing any earlier copy: a streamed reply's chunks,
 * or for the user's input, the copy `send` wrote. It keeps its place.
 */
export async function writeMessage(
  ctx: MutationCtx,
  run: Doc<"runs">,
  message: Message,
  status: "completed" | "incomplete",
  firstSeq: number,
) {
  const existing = await messageRows(ctx, message.id);
  if (message.role === "user")
    existing.push(...(await messageRows(ctx, inputMessageId(run.runId))));
  const first = existing[0];
  const runOrder = first?.runOrder ?? run._creationTime;
  const order = first?.firstSeq ?? firstSeq;
  for (const row of existing) await ctx.db.delete(row._id);
  const segments = segmentParts(message.parts);
  for (const [segment, { parts, continuesText }] of segments.entries()) {
    await ctx.db.insert("messages", {
      messageId: message.id,
      threadId: run.threadId,
      runId: run.runId,
      role: message.role,
      status,
      parts,
      segment,
      continuesText,
      createdAt: message.created_at,
      runOrder,
      firstSeq: order,
    });
  }
  await deleteChunks(ctx, message.id);
}

/** Adds streamed text to a reply that is still being written. */
export async function appendText(
  ctx: MutationCtx,
  run: Doc<"runs">,
  messageId: string,
  seq: number,
  text: string,
  createdAt: string,
) {
  const head = (await messageRows(ctx, messageId))[0];
  // A completed message supersedes its chunks; a late one changes nothing.
  if (head !== undefined && head.status !== "streaming") return;
  if (head === undefined) {
    await ctx.db.insert("messages", {
      messageId,
      threadId: run.threadId,
      runId: run.runId,
      role: "assistant",
      status: "streaming",
      parts: [],
      segment: 0,
      continuesText: false,
      createdAt,
      runOrder: run._creationTime,
      firstSeq: seq,
    });
  }
  for (const piece of splitText(text, SEGMENT_MAX_BYTES)) {
    await ctx.db.insert("message_chunks", {
      messageId,
      threadId: run.threadId,
      runId: run.runId,
      seq,
      text: piece,
    });
  }
}

export interface RunOutcome {
  status: FinalRunStatus;
  output: string | null;
  error: StoredRunError | null;
  cappedReason: CappedReason | null;
  usage: Usage | null;
}

/** The fields of a run an event batch moves along. */
export type RunProgress = Partial<
  Pick<Doc<"runs">, "accepted" | "lastSeq" | "lastEventAt" | "progress">
>;

/**
 * Records how a run ended, once: a second ending for the same run changes
 * nothing. Replies left mid-stream are kept as `incomplete`. Then the app's
 * `onRunFinished` is scheduled, after this write. `also` goes into the same
 * write of the run, so a batch that ends a run writes it once.
 */
export async function finishRun(
  ctx: MutationCtx,
  run: Doc<"runs">,
  outcome: RunOutcome,
  also: RunProgress = {},
): Promise<boolean> {
  if (isFinalStatus(run.status)) return false;
  const now = Date.now();
  await ctx.db.patch(run._id, {
    ...also,
    status: outcome.status,
    output: capText(outcome.output),
    error: outcome.error,
    cappedReason: outcome.cappedReason,
    usage: outcome.usage,
    finishedAt: now,
    nextStartAt: null,
  });
  // The run's token is of no use once it has expired.
  await ctx.scheduler.runAfter(LIVE_TOKEN_TTL_MS, internal.hercules.clearLive, {
    runId: run.runId,
  });

  const rows = await ctx.db
    .query("messages")
    .withIndex("by_run", (q) => q.eq("runId", run.runId))
    .collect();
  for (const row of rows) {
    if (row.status !== "streaming") continue;
    const text = await chunkText(ctx, row.messageId);
    await writeMessage(
      ctx,
      run,
      {
        id: row.messageId,
        thread_id: row.threadId,
        run_id: row.runId,
        role: row.role,
        parts: text.length > 0 ? [{ type: "text", text }] : [],
        created_at: row.createdAt,
      },
      "incomplete",
      row.firstSeq,
    );
  }

  const thread = await threadById(ctx, run.threadId);
  if (thread !== null && thread.activeRunId === run.runId) {
    await ctx.db.patch(thread._id, { activeRunId: null, updatedAt: now });
  }

  if (run.onRunFinished !== null) {
    const finished: RunFinished = {
      runId: run.runId,
      threadId: run.threadId,
      agentId: run.agentId,
      status: outcome.status,
      output: capText(outcome.output),
      error: outcome.error,
      cappedReason: outcome.cappedReason,
      usage: outcome.usage,
      endUser: run.endUser,
    };
    await ctx.scheduler.runAfter(
      0,
      run.onRunFinished as FunctionHandle<"mutation", RunFinished>,
      finished,
    );
  }
  return true;
}

/** About how many bytes a document takes of what a function may read. */
export function documentBytes(doc: Record<string, unknown>): number {
  return utf8Length(JSON.stringify(doc));
}

/**
 * The latest messages of a thread, oldest first: at most `limit`, and fewer
 * when they come to more than `READ_BUDGET_BYTES` (always at least one).
 * With `hideTools`, as a page may see them: `hercules` tool calls without
 * their names.
 */
export async function readMessages(
  ctx: QueryCtx,
  threadId: string,
  limit: number,
  hideTools: boolean,
) {
  const groups: Doc<"messages">[][] = [];
  let hasMore = false;
  let bytes = 0;
  for await (const row of ctx.db
    .query("messages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")) {
    const group = groups[groups.length - 1];
    if (group !== undefined && group[0]?.messageId === row.messageId) {
      // The rest of a message that is already taken: a message is read whole.
      group.unshift(row);
      bytes += documentBytes(row);
      continue;
    }
    if (groups.length === limit || bytes >= READ_BUDGET_BYTES) {
      hasMore = true;
      break;
    }
    groups.push([row]);
    bytes += documentBytes(row);
  }
  groups.reverse();
  const messages = [];
  for (const rows of groups) {
    const head = rows[0] as Doc<"messages">;
    let parts = joinSegments(rows);
    if (head.status === "streaming") {
      const text = await chunkText(ctx, head.messageId);
      parts = text.length > 0 ? [{ type: "text", text }] : [];
    }
    if (hideTools) parts = parts.map(hideToolDetails);
    messages.push({
      id: head.messageId,
      thread_id: head.threadId,
      run_id: head.runId,
      role: head.role,
      parts,
      created_at: head.createdAt,
      status: head.status,
    });
  }
  return { messages, hasMore };
}
