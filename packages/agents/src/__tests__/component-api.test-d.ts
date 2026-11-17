/**
 * `_generated/component.ts` is kept by hand (its codegen needs a deployment),
 * so this fails when it drifts from the functions it describes.
 */
import {
  internalMutationGeneric,
  type ApiFromModules,
  type FilterApi,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { describe, expectTypeOf, it } from "vitest";
import type { ComponentApi } from "../component/_generated/component";
import { runFinishedValidator, type HerculesAgentsOptions } from "../convex";
import type * as events from "../component/events";
import type * as threads from "../component/threads";

type Modules = ApiFromModules<{ events: typeof events; threads: typeof threads }>;

type Public = {
  [Module in keyof ComponentApi]: {
    [Fn in keyof ComponentApi[Module]]: Module extends keyof Modules
      ? Fn extends keyof Modules[Module]
        ? Modules[Module][Fn]
        : never
      : never;
  };
};

describe("ComponentApi", () => {
  it("matches the component's public functions", () => {
    expectTypeOf<keyof Modules["threads"]>().toEqualTypeOf<
      keyof ComponentApi["threads"] | "purge" | "forgetRunStart"
    >();
    expectTypeOf<keyof Modules["events"]>().toEqualTypeOf<keyof ComponentApi["events"]>();

    expectTypeOf<FunctionArgs<ComponentApi["threads"]["send"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["send"]>
    >();
    expectTypeOf<FunctionReturnType<ComponentApi["threads"]["send"]>>().toEqualTypeOf<
      FunctionReturnType<Public["threads"]["send"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["threads"]["read"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["read"]>
    >();
    expectTypeOf<FunctionReturnType<ComponentApi["threads"]["read"]>>().toEqualTypeOf<
      FunctionReturnType<Public["threads"]["read"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["threads"]["readDetails"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["readDetails"]>
    >();
    expectTypeOf<FunctionReturnType<ComponentApi["threads"]["readDetails"]>>().toEqualTypeOf<
      FunctionReturnType<Public["threads"]["readDetails"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["threads"]["cancel"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["cancel"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["threads"]["remove"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["remove"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["threads"]["claimPageAction"]>>().toEqualTypeOf<
      FunctionArgs<Public["threads"]["claimPageAction"]>
    >();
    expectTypeOf<FunctionArgs<ComponentApi["events"]["apply"]>>().toEqualTypeOf<
      FunctionArgs<Public["events"]["apply"]>
    >();
    expectTypeOf<FunctionReturnType<ComponentApi["events"]["apply"]>>().toEqualTypeOf<
      FunctionReturnType<Public["events"]["apply"]>
    >();
  });
});

describe("HerculesAgentsOptions", () => {
  it("takes an internal mutation declared with runFinishedValidator as onRunFinished", () => {
    const onAgentRunFinished = internalMutationGeneric({
      args: runFinishedValidator.fields,
      handler: async () => null,
    });
    type Internal = FilterApi<
      ApiFromModules<{ orders: { onAgentRunFinished: typeof onAgentRunFinished } }>,
      FunctionReference<any, "internal">
    >;
    expectTypeOf<Internal["orders"]["onAgentRunFinished"]>().toExtend<
      NonNullable<HerculesAgentsOptions["onRunFinished"]>
    >();
  });
});
