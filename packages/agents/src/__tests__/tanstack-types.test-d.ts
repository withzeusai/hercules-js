/** What the README tells an app to pass the TanStack adapter fits its types. */
import type { ConnectConnectionAdapter } from "@tanstack/ai-client";
import type { UseChatReturn } from "@tanstack/ai-react";
import type { ConvexReactClient } from "convex/react";
import { describe, expectTypeOf, it } from "vitest";
import type {
  HerculesAgentApi,
  HerculesConnection,
  HerculesConvexClient,
  SyncableChat,
} from "../tanstack";
import type { AppApi } from "./tanstack-harness";

describe("the TanStack adapter's types", () => {
  it("takes a ConvexReactClient and the app's api.agent", () => {
    expectTypeOf<ConvexReactClient>().toExtend<HerculesConvexClient>();
    expectTypeOf<AppApi["agent"]>().toExtend<HerculesAgentApi>();
  });

  it("is a TanStack connection, and takes useChat's result", () => {
    expectTypeOf<HerculesConnection>().toExtend<ConnectConnectionAdapter>();
    expectTypeOf<UseChatReturn>().toExtend<SyncableChat>();
  });
});
