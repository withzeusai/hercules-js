/**
 * The tables of the guides' app: the app's own, which the samples under
 * `docs/` read and write. Not a sample itself.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  chats: defineTable({
    threadId: v.string(),
    tokenIdentifier: v.string(),
    title: v.string(),
  })
    .index("by_thread", ["threadId"])
    .index("by_user", ["tokenIdentifier"]),
  agentReplies: defineTable({
    threadId: v.string(),
    runId: v.string(),
    reply: v.string(),
    credits: v.number(),
  }),
  users: defineTable({ tokenIdentifier: v.string() }).index("by_token", ["tokenIdentifier"]),
  tasks: defineTable({ title: v.string(), ownerId: v.id("users") }).index("by_owner", ["ownerId"]),
});
