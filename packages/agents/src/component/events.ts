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
  utf8Length,
  writeMessage,
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

async function upsertToolCall(
  ctx: MutationCtx,
  run: Doc<"runs">,
  toolCallId: string,
  fields: {
    name: string;
    kind: "hercules" | "app" | "page";
    status: "succeeded" | "failed" | "sent" | null;
    summary: string | null;
    resultJson: string | null;
    argumentsJson: string | null;
  },
) {
  const existing = await ctx.db
    .query("tool_calls")
    .withIndex("by_tool_call", (q) => q.eq("toolCallId", toolCallId))
    .unique();
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
      createdAt: Date.now(),
    });
    return;
  }
  // A page action a tab claimed from the live stream keeps its claim and its clock.
  if (existing.runId !== run.runId) return;
  await ctx.db.patch(existing._id, {
    name: fields.name,
    kind: fields.kind,
    status: fields.status ?? existing.status,
    summary: fields.summary ?? existing.summary,
    resultJson: resultJson ?? existing.resultJson,
    argumentsJson: argumentsJson ?? existing.argumentsJson,
  });
}

async function applyOne(ctx: MutationCtx, run: Doc<"runs">, event: WireEvent) {
  const data = event.data;
  switch (data.kind) {
    case "text":
      // Live-only deltas are never delivered; a stray one is not a checkpoint.
      if (event.type === "message.appended") {
        await appendText(ctx, run, data.messageId, event.seq, data.text, event.createdAt);
      }
      return;
    case "message":
      await writeMessage(ctx, run, data.message, "completed", event.seq);
      return;
    case "tool_call":
      if (event.type === "tool_call.completed") {
        await upsertToolCall(ctx, run, data.toolCallId, {
          name: data.name,
          kind: data.toolKind,
          status: data.status,
          summary: data.summary,
          resultJson: data.resultJson,
          argumentsJson: null,
        });
      }
      return;
    case "page_action":
      await upsertToolCall(ctx, run, data.toolCallId, {
        name: data.name,
        kind: "page",
        status: "sent",
        summary: null,
        resultJson: null,
        argumentsJson: data.argumentsJson,
      });
      return;
    case "progress":
      await ctx.db.patch(run._id, { progress: data.label });
      return;
    case "final":
      await finishRun(ctx, run, {
        status: data.status,
        output: data.output,
        error: data.error,
        cappedReason: data.cappedReason,
        usage: data.usage,
      });
      return;
    case "none":
      return;
  }
}

/**
 * Applies a batch of events in one transaction. Each (run_id, seq) is applied
 * once: an event at or below the run's last applied sequence number is a
 * redelivery and is skipped. Events of runs this app does not know are
 * skipped too, so a deleted thread's last events cannot stall delivery.
 */
export async function applyEvents(ctx: MutationCtx, events: readonly WireEvent[]) {
  let applied = 0;
  let skipped = 0;
  for (const [runId, list] of byRun(events)) {
    let run = await runById(ctx, runId);
    if (run === null) {
      skipped += list.length;
      continue;
    }
    for (const event of list) {
      if (event.seq <= run.lastSeq) {
        skipped++;
        continue;
      }
      // Any event means Hercules has the run, and any after `run.queued` that it started.
      const started =
        run.status === "queued" && event.type !== "run.queued" && event.data.kind !== "final";
      if (!run.accepted || started) {
        await ctx.db.patch(run._id, { accepted: true, ...(started && { status: "running" }) });
      }
      await applyOne(ctx, run, event);
      await ctx.db.patch(run._id, { lastSeq: event.seq, lastEventAt: Date.now() });
      applied++;
      run = (await ctx.db.get(run._id))!;
    }
  }
  return { applied, skipped };
}

export const apply = mutation({
  args: { events: v.array(vWireEvent) },
  returns: v.object({ applied: v.number(), skipped: v.number() }),
  handler: (ctx, { events }) => applyEvents(ctx, events),
});
