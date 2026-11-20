// convex/tools.ts
import { defineTools, tool, ToolError } from "@usehercules/agents/convex";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const tools = defineTools({
  tools: {
    list_open_tasks: tool({
      description:
        "Lists open tasks: the signed-in user's own, or everyone's for the app's own job.",
      args: { limit: v.optional(v.number()) },
      // Also the list of fields an agent may see: anything else is removed.
      returns: v.object({ tasks: v.array(v.object({ id: v.string(), title: v.string() })) }),
      annotations: { readOnlyHint: true },
      // Signed-in users, and the app's own job: `agentOrigins` is `["app"]` when left out.
      principals: ["user", "agent"],
      handler: async (ctx, args, caller) => {
        const limit = args.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          // The model reads this, and can call again.
          throw new ToolError("limit must be a whole number from 1 to 50.");
        }
        // Who is asking comes from the verified caller, never from the arguments.
        if (caller.principal === "user") {
          return await ctx.runQuery(internal.tasks.openFor, {
            tokenIdentifier: caller.tokenIdentifier,
            limit,
          });
        }
        // The app's own job: `caller.origin` is "app".
        return await ctx.runQuery(internal.tasks.openForAll, { limit });
      },
    }),
  },
});
