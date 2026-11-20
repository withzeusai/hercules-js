// convex/chats.ts
import { query } from "./_generated/server";

// The signed-in user's chats, newest first.
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return [];
    return await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .order("desc")
      .take(50);
  },
});
