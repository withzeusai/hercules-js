import { createAccessControl } from "@usehercules/convex";
import { action, mutation, query } from "./_generated/server";
import { components } from "./_generated/api";

export const {
  publicQuery,
  publicMutation,
  publicAction,
  authenticatedQuery,
  authenticatedMutation,
  authenticatedAction,
  accessQuery,
  accessMutation,
  accessAction,
} = createAccessControl({
  query,
  mutation,
  action,
  components,
});
