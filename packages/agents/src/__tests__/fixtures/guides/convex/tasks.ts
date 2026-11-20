/** `convex/tasks.ts` of the guides' app: what the tools in `tools.ts` call. Not a sample itself. */
import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const openFor = internalQuery({
  args: { tokenIdentifier: v.string(), limit: v.number() },
  handler: async (ctx, { tokenIdentifier, limit }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    if (user === null) throw new ConvexError("No account found for this user.");
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .take(limit);
    return { tasks: tasks.map((task) => ({ id: task._id, title: task.title })) };
  },
});

export const openForAll = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const tasks = await ctx.db.query("tasks").take(limit);
    return { tasks: tasks.map((task) => ({ id: task._id, title: task.title })) };
  },
});
