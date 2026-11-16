/** Applies the durable events Hercules delivers to the app. */
import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, type MutationCtx } from "./_generated/server.js";
import {
  MAX_STORED_TEXT_BYTES,
  appendText,
  finishRun,
  runById,
  toolCallById,
  utf8Length,
  writeMessage,
  type RunOutcome,
  type RunProgress,
} from "./store.js";
import { vWireEvent } from "./validators.js";

type WireEvent = Infer<typeof vWireEvent>;

/** Groups a batch by run, each run's events in sequence order. */
function byRun(events: readonly WireEvent[]): Map<string, WireEvent[]> {
  const runs = new Map<string, WireEvent[]>();
  for (const event of events) {
    const list = runs.get(event.runId);
    if (list === undefined) runs.set(event.runId, [event]);
    else list.push(event);
  }
  for (const list of runs.values()) list.sort((a, b) => a.seq - b.seq);
  return runs;
}

/** When an event was written, by its own clock. 0, which is long ago, when it does not say. */
function eventTime(event: WireEvent): number {
  const at = Date.parse(event.createdAt);
  return Number.isFinite(at) ? at : 0;
}

async function upsertToolCall(
  ctx: MutationCtx,
  run: Doc<"runs">,
  toolCallId: string,
  createdAt: number,
  fields: {
    name: string;
    kind: "hercules" | "app" | "page";
    status: "succeeded" | "failed" | "sent" | null;
    summary: string | null;
    resultJson: string | null;
    argumentsJson: string | null;
  },
) {
  // A tool call belongs to its run: another run's call with the same id is another call.
  const existing = await toolCallById(ctx, run.runId, toolCallId);
  const resultJson =
    fields.resultJson !== null && utf8Length(fields.resultJson) > MAX_STORED_TEXT_BYTES
      ? null
      : fields.resultJson;
  const argumentsJson =
    fields.argumentsJson !== null && utf8Length(fields.argumentsJson) > MAX_STORED_TEXT_BYTES
      ? "{}"
      : fields.argumentsJson;
  if (existing === null) {
    await ctx.db.insert("tool_calls", {
      toolCallId,
      threadId: run.threadId,
      runId: run.runId,
      ...fields,
      resultJson,
      argumentsJson,
      claimedAt: null,
      expired: false,
      createdAt,
    });
    return;
  }
  // The call keeps its claim, and the time of the first event that named it.
  await ctx.db.patch(existing._id, {
    name: fields.name,
    kind: fields.kind,
    status: fields.status ?? existing.status,
    summary: fields.summary ?? existing.summary,
    resultJson: resultJson ?? existing.resultJson,
    argumentsJson: argumentsJson ?? existing.argumentsJson,
  });
}

/**
 * Applies one event's own rows. What it changes of the run goes into
 * `progress`, and how it ended the run is returned: the caller writes the run
 * document once for the whole batch.
 */
async function applyOne(
  ctx: MutationCtx,
  run: Doc<"runs">,
  event: WireEvent,
  progress: RunProgress,
): Promise<RunOutcome | null> {
  const data = event.data;
  switch (data.kind) {
    case "text":
      // Live-only deltas are never delivered; a stray one is not a checkpoint.
      if (event.type === "message.appended") {
        await appendText(ctx, run, data.messageId, event.seq, data.text, event.createdAt);
      }
      return null;
    case "message":
      await writeMessage(ctx, run, data.message, "completed", event.seq);
      return null;
    case "tool_call":
      if (event.type === "tool_call.completed") {
        await upsertToolCall(ctx, run, data.toolCallId, eventTime(event), {
          name: data.name,
          kind: data.toolKind,
          status: data.status,
          summary: data.summary,
          resultJson: data.resultJson,
          argumentsJson: null,
        });
      }
      return null;
    case "page_action":
      await upsertToolCall(ctx, run, data.toolCallId, eventTime(event), {
        name: data.name,
        kind: "page",
        status: "sent",
        summary: null,
        resultJson: null,
        argumentsJson: data.argumentsJson,
      });
      return null;
    case "progress":
      progress.progress = data.label;
      return null;
    case "final":
      return {
        status: data.status,
        output: data.output,
        error: data.error,
        cappedReason: data.cappedReason,
        usage: data.usage,
      };
    case "none":
      return null;
  }
}

/**
 * Applies a batch of events in one transaction. Each (run_id, seq) is applied
 * once: an event at or below the run's last applied sequence number is a
 * redelivery and is skipped. Events of runs this app does not know are
 * skipped too, so a deleted thread's last events cannot stall delivery.
 *
 * That holds for a run's ending as well: Hercules numbers every ending above
 * everything it stored for the run, so an ending is never at or below an
 * event already applied here.
 *
 * The run document is read once and written once per run in the batch,
 * however many events the batch holds.
 */
export async function applyEvents(ctx: MutationCtx, events: readonly WireEvent[]) {
  let applied = 0;
  let skipped = 0;
  for (const [runId, list] of byRun(events)) {
    const run = await runById(ctx, runId);
    if (run === null) {
      skipped += list.length;
      continue;
    }
    let lastSeq = run.lastSeq;
    let started = false;
    let ending: RunOutcome | null = null;
    const progress: RunProgress = {};
    for (const event of list) {
      if (event.seq <= lastSeq) {
        skipped++;
        continue;
      }
      const ended = await applyOne(ctx, run, event, progress);
      // The first ending counts; a run ends once.
      ending ??= ended;
      // Any event after `run.queued` means the run started.
      if (event.type !== "run.queued" && ended === null) started = true;
      lastSeq = event.seq;
      applied++;
    }
    if (lastSeq === run.lastSeq) continue;
    // Any event means Hercules has the run, and that delivery works: the
    // stuck-run check goes back to its shortest wait.
    const also: RunProgress = {
      ...progress,
      accepted: true,
      lastSeq,
      lastEventAt: Date.now(),
      quietChecks: 0,
    };
    if (ending !== null && (await finishRun(ctx, run, ending, also))) continue;
    await ctx.db.patch(run._id, {
      ...also,
      ...(run.status === "queued" && started && { status: "running" as const }),
    });
  }
  return { applied, skipped };
}

export const apply = mutation({
  args: { events: v.array(vWireEvent) },
  returns: v.object({ applied: v.number(), skipped: v.number() }),
  handler: (ctx, { events }) => applyEvents(ctx, events),
});
