/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * In the shape `npx convex codegen --component-dir src/component` writes.
 * That command needs a deployment, so these files are kept by hand: change
 * them with the functions, or regenerate them against a dev deployment.
 * @module
 */

import type * as events from "../events.js";
import type * as hercules from "../hercules.js";
import type * as threads from "../threads.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  events: typeof events;
  hercules: typeof hercules;
  threads: typeof threads;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
