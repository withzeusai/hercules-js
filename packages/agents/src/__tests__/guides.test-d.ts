/**
 * The guides' app (`fixtures/guides`), type-checked the way an app's is:
 * the samples in `docs/` are its files, word for word (`guides.test.ts`
 * holds that), and they import the package by its name. This file is what
 * makes the type-check read them, and holds what each sample comes to, so
 * that one which compiles to something else than the guide says also fails.
 */
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expectTypeOf, it } from "vitest";
import type {
  DefinedTools,
  HerculesAgents,
  HerculesAgentsOptions,
  StoredToolCall,
} from "../convex";
import type { AgentThread } from "../react";
import type { HerculesAgentApi } from "../tanstack";
import type { api, internal } from "./fixtures/guides/convex/_generated/api";
import type { support } from "./fixtures/guides/convex/agent";
import type { tools } from "./fixtures/guides/convex/tools";
import type { AgentChat } from "./fixtures/guides/src/components/agent-chat";
import type { SupportChat } from "./fixtures/guides/src/components/support-chat";
import type { limitEndsAt } from "./fixtures/guides/src/lib/limit-ends-at";
import type { readReply } from "./fixtures/guides/src/lib/read-reply";
import type { watchRun } from "./fixtures/guides/src/lib/watch-run";

type Started = { threadId: string; runId: string };

describe("docs/convex.md", () => {
  it("declares the agent with its annotation, beside a send of the app's own", () => {
    expectTypeOf<typeof support>().toEqualTypeOf<HerculesAgents>();
    expectTypeOf<typeof internal.orders.onAgentRunFinished>().toExtend<
      NonNullable<HerculesAgentsOptions["onRunFinished"]>
    >();
    // The app's own `send` keeps the arguments and the result the chat needs.
    expectTypeOf<FunctionArgs<typeof api.agent.send>>().toEqualTypeOf<{
      threadId?: string;
      text: string;
      context?: Record<string, any>;
    }>();
    expectTypeOf<FunctionReturnType<typeof api.agent.send>>().toEqualTypeOf<Started>();
    expectTypeOf<typeof api.agent>().toExtend<HerculesAgentApi>();
  });

  it("lists a user's chats, runs the agent with no user, and reads what its tools did", () => {
    expectTypeOf<FunctionReturnType<typeof api.chats.mine>[number]["threadId"]>().toBeString();
    expectTypeOf<
      FunctionReturnType<typeof internal.reports.summarizeOrders>
    >().toEqualTypeOf<Started>();
    expectTypeOf<FunctionReturnType<typeof internal.audit.toolCallsOf>>().toEqualTypeOf<
      StoredToolCall[]
    >();
  });
});

describe("docs/tools.md", () => {
  it("defines a tool for both callers", () => {
    expectTypeOf<typeof tools>().toEqualTypeOf<DefinedTools>();
  });
});

describe("docs/chat.md", () => {
  it("builds the chat with TanStack AI, and without it", () => {
    expectTypeOf<Parameters<typeof AgentChat>[0]>().toEqualTypeOf<{ threadId: string }>();
    expectTypeOf<Parameters<typeof SupportChat>[0]>().toEqualTypeOf<{
      openOrder: (orderId: string) => void;
    }>();
  });
});

describe("docs/events-and-errors.md", () => {
  it("follows a run, and says when a limit is over", () => {
    expectTypeOf<typeof readReply>().toEqualTypeOf<
      (live: { url: string; token: string }) => Promise<string>
    >();
    expectTypeOf<ReturnType<typeof watchRun>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<typeof limitEndsAt>().toEqualTypeOf<
      (thread: AgentThread | null | undefined) => Date | null
    >();
  });
});
