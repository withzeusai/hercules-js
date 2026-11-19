/**
 * The README's `convex/agent.ts`, type-checked the way an app's is: against
 * an `internal` typed from the app's own modules (`fixtures/app`). The
 * fixture is part of the check: `pnpm test` fails if `support` cannot be
 * declared as the README declares it, with its `HerculesAgents` annotation.
 */
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expectTypeOf, it } from "vitest";
import type { AgentThread, HerculesAgents, HerculesAgentsOptions } from "../convex";
import type { api, internal } from "./fixtures/app/_generated/api";
import type { support } from "./fixtures/app/agent";

describe("an app's convex/agent.ts", () => {
  it("declares the agent with an annotation, next to an onRunFinished from internal", () => {
    expectTypeOf<typeof support>().toEqualTypeOf<HerculesAgents>();
    expectTypeOf<typeof internal.orders.onAgentRunFinished>().toExtend<
      NonNullable<HerculesAgentsOptions["onRunFinished"]>
    >();
  });

  it("exports the page's functions through the generated api, fully typed", () => {
    expectTypeOf<FunctionArgs<typeof api.agent.send>>().toEqualTypeOf<{
      threadId?: string;
      text: string;
      context?: Record<string, any>;
    }>();
    expectTypeOf<FunctionReturnType<typeof api.agent.send>>().toEqualTypeOf<{
      threadId: string;
      runId: string;
    }>();
    expectTypeOf<FunctionArgs<typeof api.agent.thread>>().toEqualTypeOf<{
      threadId: string;
      limit?: number;
    }>();
    expectTypeOf<FunctionReturnType<typeof api.agent.thread>>().toEqualTypeOf<AgentThread | null>();
    expectTypeOf<FunctionArgs<typeof api.agent.deleteThread>>().toEqualTypeOf<{
      threadId: string;
    }>();
    expectTypeOf<FunctionArgs<typeof api.agent.cancel>>().toEqualTypeOf<{ threadId: string }>();
    expectTypeOf<FunctionArgs<typeof api.agent.claimPageAction>>().toEqualTypeOf<{
      threadId: string;
      runId: string;
      toolCallId: string;
    }>();
  });
});
