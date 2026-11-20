// convex/agent.ts
import { HerculesAgents } from "@usehercules/agents/convex";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { mutation } from "./_generated/server";

// Keep the `: HerculesAgents` annotation.
export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  onRunFinished: internal.orders.onAgentRunFinished,
  // Only names the agent declares.
  pageActions: ["open_order"],
});

export const { thread, cancel, claimPageAction, deleteThread } = support.api();

// `send`, with each new thread saved for the user who opened it.
export const send = mutation({
  args: {
    threadId: v.optional(v.string()),
    text: v.string(),
    context: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    // Throws `sign_in_required` when no one is signed in.
    const started = await support.send(ctx, args);
    const identity = await ctx.auth.getUserIdentity();
    const saved = await ctx.db
      .query("chats")
      .withIndex("by_thread", (q) => q.eq("threadId", started.threadId))
      .unique();
    if (saved === null && identity !== null) {
      await ctx.db.insert("chats", {
        threadId: started.threadId,
        tokenIdentifier: identity.tokenIdentifier,
        title: args.text.slice(0, 80),
      });
    }
    // The page needs the run's id: return what `support.send` returned.
    return started;
  },
});
