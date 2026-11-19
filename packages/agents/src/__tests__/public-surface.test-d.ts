/**
 * The public surface as TypeScript sees it, from the source: the values each
 * entry point exports, exactly, and every type it exports under its name.
 * `public-surface.test.ts` holds the same lists against what is built and
 * published, and is the one that catches a type added by accident: a
 * module's type exports cannot be listed from inside the type system.
 *
 * A name that is removed or renamed fails to compile here. So does a type
 * that has quietly become `any`, which every use of it would then pass.
 */
import { describe, expectTypeOf, it } from "vitest";
import type * as Generated from "../component/_generated/component";
import type * as Config from "../component/convex.config";
import type * as Convex from "../convex";
import type * as Root from "../index";
import type * as ReactEntry from "../react";
import type * as Tanstack from "../tanstack";

type IsAny<T> = 0 extends 1 & T ? true : false;
/** `false` when none of the listed types is `any`. */
type AnyAmong<Types extends readonly unknown[]> = {
  [Index in keyof Types]: IsAny<Types[Index]>;
}[number];

describe("the values each entry point exports", () => {
  it("are exactly these", () => {
    expectTypeOf<keyof typeof Root>().toEqualTypeOf<"RunStreamError" | "ToolError" | "followRun">();
    expectTypeOf<keyof typeof Convex>().toEqualTypeOf<
      "HerculesAgents" | "ToolError" | "defineTools" | "runFinishedValidator" | "tool"
    >();
    expectTypeOf<keyof typeof ReactEntry>().toEqualTypeOf<
      "AgentError" | "RunStreamError" | "useAgentThread"
    >();
    expectTypeOf<keyof typeof Tanstack>().toEqualTypeOf<
      | "PAGE_ACTION_OUTPUT"
      | "PROGRESS_EVENT"
      | "agentErrorCode"
      | "herculesConnection"
      | "useThreadSync"
    >();
    expectTypeOf<keyof typeof Config>().toEqualTypeOf<"default">();
    expectTypeOf<keyof typeof Generated>().toEqualTypeOf<never>();
  });
});

describe("the types each entry point exports", () => {
  it("are all there from @usehercules/agents", () => {
    expectTypeOf<
      AnyAmong<
        [
          Root.AgentEvent,
          Root.AgentEventOf<"run.started">,
          Root.AgentEventType,
          Root.AgentOrigin,
          Root.CappedReason,
          Root.EventDataByType,
          Root.FinalRunStatus,
          Root.Message,
          Root.MessagePart,
          Root.Run,
          Root.RunError,
          Root.RunStatus,
          Root.RunStreamOptions,
          Root.TextPart,
          Root.ToolAnnotations,
          Root.ToolCallPart,
          Root.ToolCallStatus,
          Root.ToolCaller,
          Root.ToolKind,
          Root.ToolPrincipal,
          Root.UnknownName,
          Root.Usage,
        ]
      >
    >().toEqualTypeOf<false>();
  });

  it("are all there from /convex", () => {
    expectTypeOf<
      AnyAmong<
        [
          Convex.ActiveRun,
          Convex.AgentErrorCode,
          Convex.AgentErrorData,
          Convex.AgentOrigin,
          Convex.AgentThread,
          Convex.AgentThreadDetails,
          Convex.ConvexTool,
          Convex.DefinedTools,
          Convex.HerculesAgentsOptions,
          Convex.PendingPageAction,
          Convex.RunFinished,
          Convex.SendArgs,
          Convex.StoredToolCall,
          Convex.ThreadArgs,
          Convex.ThreadMessage,
          Convex.ToolAnnotations,
          Convex.ToolCaller,
          Convex.ToolCtx,
          Convex.ToolDefinition<{}, undefined, "user">,
          Convex.ToolPrincipal,
          Convex.ToolsDefinition,
        ]
      >
    >().toEqualTypeOf<false>();
    // The same types as the root's, not copies that could drift.
    expectTypeOf<Convex.ToolCaller>().toEqualTypeOf<Root.ToolCaller>();
    expectTypeOf<Convex.AgentOrigin>().toEqualTypeOf<Root.AgentOrigin>();
  });

  it("are all there from /react", () => {
    expectTypeOf<
      AnyAmong<
        [
          ReactEntry.AgentThread,
          ReactEntry.AgentThreadStatus,
          ReactEntry.PageActionHandler,
          ReactEntry.SendMutationArgs,
          ReactEntry.UseAgentThreadOptions,
          ReactEntry.UseAgentThreadResult,
          ReactEntry.ViewMessage,
          ReactEntry.ViewPart,
          ReactEntry.ViewToolCallPart,
        ]
      >
    >().toEqualTypeOf<false>();
    expectTypeOf<ReactEntry.AgentThread>().toEqualTypeOf<Convex.AgentThread>();
  });

  it("are all there from /tanstack", () => {
    expectTypeOf<
      AnyAmong<
        [
          Tanstack.AgentThread,
          Tanstack.HerculesAgentApi,
          Tanstack.HerculesConnection,
          Tanstack.HerculesConnectionOptions,
          Tanstack.HerculesConvexClient,
          Tanstack.HerculesMessageMetadata,
          Tanstack.HerculesToolOutput,
          Tanstack.PageActionHandler,
          Tanstack.PageActionHandlers,
          Tanstack.SyncableChat,
        ]
      >
    >().toEqualTypeOf<false>();
    expectTypeOf<Tanstack.AgentThread>().toEqualTypeOf<Convex.AgentThread>();
    expectTypeOf<Tanstack.PageActionHandler>().toEqualTypeOf<ReactEntry.PageActionHandler>();
  });

  it("is the component's API from /_generated/component", () => {
    expectTypeOf<IsAny<Generated.ComponentApi>>().toEqualTypeOf<false>();
    // What `new HerculesAgents(...)` takes: an app passes `components.herculesAgents`.
    expectTypeOf<Generated.ComponentApi>().toEqualTypeOf<
      ConstructorParameters<typeof Convex.HerculesAgents>[0]
    >();
  });
});

// A class's public members and an object's keys are API as its exports are.
describe("the members an app can call", () => {
  it("are exactly these on HerculesAgents and on what its api() builds", () => {
    expectTypeOf<keyof Convex.HerculesAgents>().toEqualTypeOf<
      | "send"
      | "run"
      | "readThread"
      | "readThreadDetails"
      | "cancel"
      | "deleteThread"
      | "claimPageAction"
      | "api"
      | "handleEvents"
      | "registerRoutes"
    >();
    expectTypeOf<keyof ReturnType<Convex.HerculesAgents["api"]>>().toEqualTypeOf<
      "send" | "thread" | "cancel" | "claimPageAction" | "deleteThread"
    >();
    expectTypeOf<keyof Convex.HerculesAgentsOptions>().toEqualTypeOf<
      | "agentId"
      | "onRunFinished"
      | "limits"
      | "exposeToolDetails"
      | "pageActions"
      | "apiKey"
      | "apiUrl"
      | "issuer"
    >();
  });

  it("are exactly these on what defineTools returns and takes", () => {
    expectTypeOf<keyof Convex.DefinedTools>().toEqualTypeOf<"registerRoutes">();
    expectTypeOf<keyof Convex.ToolsDefinition>().toEqualTypeOf<
      "name" | "instructions" | "tools" | "issuer" | "audiences"
    >();
    expectTypeOf<keyof Convex.ToolDefinition<{}, undefined, "user">>().toEqualTypeOf<
      "description" | "args" | "returns" | "annotations" | "principals" | "agentOrigins" | "handler"
    >();
  });

  it("are exactly these in the page", () => {
    expectTypeOf<keyof ReactEntry.UseAgentThreadOptions>().toEqualTypeOf<
      "threadId" | "thread" | "send" | "cancel" | "claimPageAction" | "pageActions" | "fetch"
    >();
    expectTypeOf<keyof ReactEntry.UseAgentThreadResult>().toEqualTypeOf<
      "messages" | "status" | "send" | "cancel" | "error"
    >();
    expectTypeOf<keyof Tanstack.HerculesConnectionOptions>().toEqualTypeOf<
      "pageActions" | "fetch" | "retry" | "settleTimeoutMs"
    >();
    expectTypeOf<keyof Tanstack.HerculesAgentApi>().toEqualTypeOf<
      "send" | "thread" | "cancel" | "claimPageAction"
    >();
    expectTypeOf<keyof Root.RunStreamOptions>().toEqualTypeOf<
      "url" | "token" | "after" | "signal" | "fetch" | "retry"
    >();
  });
});
