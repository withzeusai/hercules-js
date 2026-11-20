// convex/audit.ts
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { support } from "./agent";

// Internal: `readThreadDetails` answers for any user's thread.
export const toolCallsOf = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const details = await support.readThreadDetails(ctx, { threadId });
    return details?.toolCalls ?? [];
  },
});
