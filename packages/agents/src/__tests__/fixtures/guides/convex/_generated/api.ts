/**
 * `convex/_generated/api.ts` as Convex writes it for an app: `internal` and
 * `api` are typed from every module's exports.
 */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";
import type { ComponentApi } from "../../../../../component/_generated/component";
import type * as agent from "../agent";
import type * as audit from "../audit";
import type * as chats from "../chats";
import type * as orders from "../orders";
import type * as reports from "../reports";
import type * as tasks from "../tasks";
import type * as tools from "../tools";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  audit: typeof audit;
  chats: typeof chats;
  orders: typeof orders;
  reports: typeof reports;
  tasks: typeof tasks;
  tools: typeof tools;
}>;

export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;
export const components = componentsGeneric() as unknown as {
  herculesAgents: ComponentApi<"herculesAgents">;
};
