/**
 * `convex/_generated/api.ts` as Convex writes it for an app: `internal` and
 * `api` are typed from every module's exports, the agent module's included.
 */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";
import type { ComponentApi } from "../../../../component/_generated/component";
import type * as agent from "../agent";
import type * as orders from "../orders";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  orders: typeof orders;
}>;

export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;
export const components = componentsGeneric() as unknown as {
  herculesAgents: ComponentApi<"herculesAgents">;
};
