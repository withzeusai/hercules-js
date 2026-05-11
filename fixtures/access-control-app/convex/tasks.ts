import { v } from "convex/values";
import { accessMutation, authenticatedQuery, publicQuery } from "./access";

export const listPublicTasks = publicQuery({
  args: {},
  handler: async () => {
    return [];
  },
});

export const getCurrentUserTasks = authenticatedQuery({
  args: {},
  handler: async () => {
    return [];
  },
});

export const createTask = accessMutation({
  permission: "tasks:create",
  args: {
    title: v.string(),
  },
  handler: async (_ctx, args) => {
    return {
      title: args.title,
    };
  },
});
