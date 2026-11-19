/**
 * The naming rule, held in the type system (see "Naming" in the README):
 *
 * - What the package builds for the app is camelCase: the thread and
 *   everything in it, what the hooks return, what `onRunFinished` and a
 *   tool's handler are called with, every option.
 * - What is the Hercules API's own JSON keeps the API's names: `AgentEvent`,
 *   `Message` and `Run`. Those are the only exemptions, and each is listed
 *   below with exactly the fields that make it one. A new exemption is a
 *   line added here on purpose.
 *
 * It looks at field names, at every depth. String values (event types such
 * as `tool_call.completed`, statuses, error codes) are the API's vocabulary
 * and are not names. Opaque data (tool arguments and results, `context`) is
 * typed `unknown` or `any`, and is never looked into.
 */
import type { FunctionReference } from "convex/server";
import type { GenericValidator } from "convex/values";
import { describe, expectTypeOf, it } from "vitest";
import type * as Convex from "../convex";
import type * as Root from "../index";
import type * as ReactEntry from "../react";
import type * as Tanstack from "../tanstack";

type IsAny<T> = 0 extends 1 & T ? true : false;

/** A name with an underscore inside it: `created_at`, not Convex's own `_id`. */
type IsSnake<Key> = Key extends `${infer Head}_${infer Tail}`
  ? Head extends ""
    ? false
    : Tail extends ""
      ? false
      : true
  : false;

/** What is not the package's own data: other libraries' objects, and functions. */
type NotLookedInto =
  | ((...args: never[]) => unknown)
  | AbortSignal
  | Date
  | Error
  | Promise<unknown>
  | GenericValidator
  | FunctionReference<any, any>;

type Deeper = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/** The snake_case field names in a type, at every depth. `never` when there are none. */
type SnakeNames<T, Depth extends number = 8> = [Depth] extends [never]
  ? never
  : IsAny<T> extends true
    ? never
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? never
      : T extends NotLookedInto
        ? never
        : T extends readonly (infer Element)[]
          ? SnakeNames<Element, Deeper[Depth]>
          : T extends object
            ? {
                [Key in keyof T]-?:
                  | (IsSnake<Key> extends true ? Key : never)
                  | SnakeNames<T[Key], Deeper[Depth]>;
              }[keyof T]
            : never;

type Agent = Convex.HerculesAgents;
type Returned<Method extends keyof Agent> = Agent[Method] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;

describe("the walker", () => {
  it("finds a snake_case name at any depth, and only a name", () => {
    expectTypeOf<
      SnakeNames<{ ok: { list: { created_at: string; fine: "a_value" }[] } }>
    >().toEqualTypeOf<"created_at">();
    expectTypeOf<
      SnakeNames<{ _id: string; context: Record<string, unknown>; result?: unknown; any: any }>
    >().toEqualTypeOf<never>();
  });
});

describe("what the package builds for the app", () => {
  it("has no snake_case name in what the backend reads and is called with", () => {
    expectTypeOf<
      SnakeNames<
        [
          Convex.AgentThread,
          Convex.AgentThreadDetails,
          Convex.ThreadMessage,
          Convex.ActiveRun,
          Convex.PendingPageAction,
          Convex.StoredToolCall,
          Convex.RunFinished,
          Convex.AgentErrorData,
          Convex.ToolCaller,
          Returned<"send">,
          Returned<"run">,
          Returned<"readThread">,
          Returned<"readThreadDetails">,
          Returned<"cancel">,
          Returned<"deleteThread">,
          Returned<"claimPageAction">,
        ]
      >
    >().toEqualTypeOf<never>();
  });

  it("has none in what the app passes in", () => {
    expectTypeOf<
      SnakeNames<
        [
          Convex.HerculesAgentsOptions,
          Convex.SendArgs,
          Convex.ThreadArgs,
          Convex.ToolsDefinition,
          Convex.ToolDefinition<{}, undefined, "user" | "agent">,
          Convex.ToolAnnotations,
          Convex.DefinedTools,
          Convex.ConvexTool,
          Root.RunStreamOptions,
          ReactEntry.UseAgentThreadOptions,
          ReactEntry.SendMutationArgs,
          Tanstack.HerculesConnectionOptions,
          Tanstack.PageActionHandlers,
        ]
      >
    >().toEqualTypeOf<never>();
  });

  it("has none in what the page reads", () => {
    expectTypeOf<
      SnakeNames<
        [
          ReactEntry.UseAgentThreadResult,
          ReactEntry.ViewMessage,
          ReactEntry.ViewPart,
          ReactEntry.ViewToolCallPart,
          ReactEntry.AgentThread,
          ReactEntry.AgentError,
          ReactEntry.RunStreamError,
          Tanstack.AgentThread,
          Tanstack.HerculesMessageMetadata,
          Tanstack.HerculesToolOutput,
          ReturnType<typeof Tanstack.useThreadSync>,
        ]
      >
    >().toEqualTypeOf<never>();
  });

  it("has none in the parts of a message and the small types beside them", () => {
    expectTypeOf<
      SnakeNames<
        [
          Root.MessagePart,
          Root.TextPart,
          Root.ToolCallPart,
          Root.RunError,
          Root.Usage,
          Root.ToolCaller,
          Root.ToolAnnotations,
        ]
      >
    >().toEqualTypeOf<never>();
  });
});

describe("the Hercules API's own JSON, the only exemptions", () => {
  it("is Message, with the API's names", () => {
    expectTypeOf<SnakeNames<Root.Message>>().toEqualTypeOf<"thread_id" | "run_id" | "created_at">();
  });

  it("is Run, with the API's names", () => {
    expectTypeOf<SnakeNames<Root.Run>>().toEqualTypeOf<
      "thread_id" | "agent_id" | "capped_reason" | "created_at" | "finished_at"
    >();
  });

  it("is AgentEvent, with the API's names in its envelope and its data", () => {
    expectTypeOf<SnakeNames<Root.AgentEvent>>().toEqualTypeOf<
      "run_id" | "thread_id" | "created_at" | "message_id" | "tool_call_id" | "capped_reason"
    >();
    // The same events, by type. The event types are the API's too.
    expectTypeOf<SnakeNames<Root.EventDataByType>>().toEqualTypeOf<
      | "tool_call.started"
      | "tool_call.completed"
      | "page_action"
      | "run_id"
      | "thread_id"
      | "created_at"
      | "message_id"
      | "tool_call_id"
      | "capped_reason"
    >();
  });
});
