/** `convex/_generated/server.ts` as Convex writes it: the builders, typed from the app's schema. */
import {
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import type { DataModel } from "./dataModel";

export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
