// convex/reports.ts
import { internalMutation } from "./_generated/server";
import { support } from "./agent";

// Internal: `run` checks no caller and no limit. Schedule it from a cron, say.
export const summarizeOrders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { threadId, runId } = await support.run(ctx, { text: "Summarize today's new orders." });
    return { threadId, runId };
  },
});
