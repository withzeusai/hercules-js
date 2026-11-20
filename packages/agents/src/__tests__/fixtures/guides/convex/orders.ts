// convex/orders.ts
import { runFinishedValidator } from "@usehercules/agents/convex";
import { internalMutation } from "./_generated/server";

export const onAgentRunFinished = internalMutation({
  args: runFinishedValidator.fields,
  handler: async (ctx, run) => {
    // run.status is "completed", "failed", "cancelled" or "capped".
    if (run.status !== "completed" || run.output === null) return;
    await ctx.db.insert("agentReplies", {
      threadId: run.threadId,
      runId: run.runId,
      reply: run.output,
      credits: run.usage?.credits ?? 0,
    });
  },
});
