/** `convex/orders.ts` of the README's app. */
import { internalMutationGeneric } from "convex/server";
import { runFinishedValidator } from "../../../convex";

export const onAgentRunFinished = internalMutationGeneric({
  args: runFinishedValidator.fields,
  handler: async () => null,
});
