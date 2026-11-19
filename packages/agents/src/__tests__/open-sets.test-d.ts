/**
 * The open sets, held in the type system (see "Open sets" in the README).
 *
 * Hercules may add a value to any of them without a new API version, and a
 * later version of the package may then name it. An app keeps compiling
 * through both only if its code was never allowed to be exhaustive. So for
 * each set, this file proves two things:
 *
 * - A `switch` that lists every value this version knows and ends in
 *   `assertNever` does NOT compile: the `default` branch is never empty.
 * - Comparing with a value this version does not know DOES compile.
 *
 * A union told apart by a name (an event's `type`, a part's `type`, a
 * caller's `principal`) narrows as usual on the names this version knows,
 * and what is left in `default` is the member for the names it does not
 * know. TypeScript cannot compare that name with a string directly without
 * losing the narrowing, so it is read with `String(...)`.
 *
 * The statuses the package defines itself are open too, for its own later
 * versions. The one set that is closed on purpose is held at the end.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { ComponentApi } from "../component/_generated/component";
import type * as Convex from "../convex";
import type * as Root from "../index";
import type * as ReactEntry from "../react";
import type * as Tanstack from "../tanstack";

declare function assertNever(value: never): never;

/** Whether any string at all fits: what makes a set open. */
type TakesAnyString<Set> = string extends Set ? true : false;

type Thread = Convex.AgentThread;
type LatestRun = NonNullable<Thread["latestRun"]>;
type ActiveRun = NonNullable<Thread["activeRun"]>;

describe("sets of plain strings", () => {
  it("a run's status", () => {
    const known = (status: Root.RunStatus) => {
      switch (status) {
        case "queued":
        case "running":
        case "completed":
        case "failed":
        case "cancelled":
        case "capped":
          return status;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(status);
      }
    };
    const later = (run: Root.Run, latest: LatestRun, active: ActiveRun) =>
      run.status === "waiting" || latest.status === "waiting" || active.status === "waiting";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<Root.Run["status"]>>().toEqualTypeOf<true>();
    expectTypeOf<TakesAnyString<LatestRun["status"]>>().toEqualTypeOf<true>();
    expectTypeOf<TakesAnyString<ActiveRun["status"]>>().toEqualTypeOf<true>();
  });

  it("the status of the run going on a thread", () => {
    const known = (status: ActiveRun["status"]) => {
      switch (status) {
        case "queued":
        case "running":
          return status;
        default:
          // @ts-expect-error A status that is not final, added later, lands here.
          return assertNever(status);
      }
    };
    expectTypeOf(known).toBeFunction();
  });

  it("why a run was capped", () => {
    const known = (reason: Root.CappedReason) => {
      switch (reason) {
        case "steps":
        case "time":
        case "credits":
        case "output":
          return reason;
        default:
          // @ts-expect-error A reason added later lands here.
          return assertNever(reason);
      }
    };
    const later = (run: Root.Run, latest: LatestRun, finished: Convex.RunFinished) =>
      run.capped_reason === "tokens" ||
      latest.cappedReason === "tokens" ||
      finished.cappedReason === "tokens";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<NonNullable<LatestRun["cappedReason"]>>>().toEqualTypeOf<true>();
    expectTypeOf<
      TakesAnyString<NonNullable<Convex.RunFinished["cappedReason"]>>
    >().toEqualTypeOf<true>();
  });

  it("a tool call's kind and how it ended", () => {
    const kind = (value: Root.ToolKind) => {
      switch (value) {
        case "hercules":
        case "app":
        case "page":
          return value;
        default:
          // @ts-expect-error A kind added later lands here.
          return assertNever(value);
      }
    };
    const status = (value: Root.ToolCallStatus) => {
      switch (value) {
        case "succeeded":
        case "failed":
        case "sent":
          return value;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(value);
      }
    };
    const later = (part: Root.ToolCallPart, stored: Convex.StoredToolCall) =>
      part.kind === "subagent" ||
      part.status === "denied" ||
      stored.kind === "subagent" ||
      stored.status === "denied";
    expectTypeOf(kind).toBeFunction();
    expectTypeOf(status).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<Convex.StoredToolCall["kind"]>>().toEqualTypeOf<true>();
    expectTypeOf<
      TakesAnyString<Extract<ReactEntry.ViewPart, { type: "tool_call" }>["status"]>
    >().toEqualTypeOf<true>();
  });

  it("a message's role", () => {
    const known = (role: Root.Message["role"]) => {
      switch (role) {
        case "user":
        case "assistant":
          return role;
        default:
          // @ts-expect-error A role added later lands here.
          return assertNever(role);
      }
    };
    const later = (message: Root.Message, stored: Convex.ThreadMessage) =>
      message.role === "system" || stored.role === "system";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<Convex.ThreadMessage["role"]>>().toEqualTypeOf<true>();
    expectTypeOf<TakesAnyString<ReactEntry.ViewMessage["role"]>>().toEqualTypeOf<true>();
  });

  it("the name of an event type", () => {
    const known = (type: Root.AgentEventType) => {
      switch (type) {
        case "run.queued":
        case "run.started":
        case "message.delta":
        case "message.appended":
        case "message.completed":
        case "tool_call.started":
        case "tool_call.completed":
        case "page_action":
        case "run.progress":
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
        case "run.capped":
          return type;
        default:
          // @ts-expect-error A type added later lands here.
          return assertNever(type);
      }
    };
    const later = (type: Root.AgentEventType) => type === "run.waiting";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
  });

  it("the error codes: of send, of a run, of the page", () => {
    const known = (code: Convex.AgentErrorCode) => {
      switch (code) {
        case "sign_in_required":
        case "not_found":
        case "thread_deleted":
        case "thread_busy":
        case "end_user_rate_limited":
        case "message_too_long":
        case "invalid_request":
          return code;
        default:
          // @ts-expect-error A code added later lands here.
          return assertNever(code);
      }
    };
    const later = (
      thrown: Convex.AgentErrorData,
      run: Root.RunError,
      latest: LatestRun,
      finished: Convex.RunFinished,
      page: ReactEntry.AgentError,
      stream: ReactEntry.RunStreamError,
    ) =>
      thrown.code === "a_code_added_later" ||
      run.code === "a_code_added_later" ||
      latest.error?.code === "a_code_added_later" ||
      finished.error?.code === "a_code_added_later" ||
      page.code === "a_code_added_later" ||
      stream.code === "a_code_added_later";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<ReturnType<typeof Tanstack.agentErrorCode>>().toEqualTypeOf<string | null>();
    expectTypeOf<TakesAnyString<Convex.AgentErrorData["code"]>>().toEqualTypeOf<true>();
  });

  it("where a run with no end user was started, and the kind of caller", () => {
    const origin = (value: Convex.AgentOrigin) => {
      switch (value) {
        case "app":
        case "organization":
        case "console":
        case "trigger":
        case "channel":
        case "schedule":
        case "test":
        case "other":
          return value;
        default:
          // @ts-expect-error An origin added later lands here.
          return assertNever(value);
      }
    };
    const principal = (value: Convex.ToolPrincipal) => {
      switch (value) {
        case "user":
        case "agent":
          return value;
        default:
          // @ts-expect-error A kind of caller added later lands here.
          return assertNever(value);
      }
    };
    const later = (o: Convex.AgentOrigin, p: Convex.ToolPrincipal) =>
      o === "webhook" || p === "service";
    expectTypeOf(origin).toBeFunction();
    expectTypeOf(principal).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
  });
});

// The statuses the package defines itself. Hercules does not add to these: a
// later version of the package may, for a message held for a person, a page
// action that waits for approval, or a run that is paused. They are open so
// that it can do so in a minor version, and an app's code has its default
// from the start.
describe("the sets the package defines for itself", () => {
  it("a thread message's status, in the thread and in both hooks", () => {
    const known = (status: Convex.ThreadMessage["status"]) => {
      switch (status) {
        case "streaming":
        case "completed":
        case "incomplete":
          return status;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(status);
      }
    };
    const shown = (status: ReactEntry.ViewMessage["status"]) => {
      switch (status) {
        case "streaming":
        case "completed":
        case "incomplete":
        case "pending":
          return status;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(status);
      }
    };
    const later = (
      stored: Convex.ThreadMessage,
      view: ReactEntry.ViewMessage,
      metadata: Tanstack.HerculesMessageMetadata,
    ) =>
      stored.status === "queued" || view.status === "queued" || metadata.messageStatus === "queued";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(shown).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<Convex.ThreadMessage["status"]>>().toEqualTypeOf<true>();
    expectTypeOf<TakesAnyString<ReactEntry.ViewMessage["status"]>>().toEqualTypeOf<true>();
    expectTypeOf<
      TakesAnyString<NonNullable<Tanstack.HerculesMessageMetadata["messageStatus"]>>
    >().toEqualTypeOf<true>();
    // The names this version knows still complete in an editor and narrow.
    const cutOff = (message: Convex.ThreadMessage) => message.status === "incomplete";
    expectTypeOf(cutOff).returns.toBeBoolean();
  });

  it("a page action's status", () => {
    const known = (status: Convex.PendingPageAction["status"]) => {
      switch (status) {
        case "pending":
        case "expired":
          return status;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(status);
      }
    };
    const later = (action: Convex.PendingPageAction) => action.status === "awaiting_approval";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<Convex.PendingPageAction["status"]>>().toEqualTypeOf<true>();
    expectTypeOf<
      TakesAnyString<ReactEntry.AgentThread["pageActions"][number]["status"]>
    >().toEqualTypeOf<true>();
  });

  it("useAgentThread's status", () => {
    const known = (status: ReactEntry.AgentThreadStatus) => {
      switch (status) {
        case "loading":
        case "ready":
        case "submitted":
        case "streaming":
          return status;
        default:
          // @ts-expect-error A status added later lands here.
          return assertNever(status);
      }
    };
    const later = (result: ReactEntry.UseAgentThreadResult) => result.status === "waiting";
    // What the README tells a page to do: only `ready` takes a new message.
    const canSend = (result: ReactEntry.UseAgentThreadResult) => result.status === "ready";
    expectTypeOf(known).toBeFunction();
    expectTypeOf(later).returns.toBeBoolean();
    expectTypeOf(canSend).returns.toBeBoolean();
    expectTypeOf<TakesAnyString<ReactEntry.AgentThreadStatus>>().toEqualTypeOf<true>();
  });
});

describe("unions told apart by a name", () => {
  it("an event: narrows on the types this version knows, and is never exhausted", () => {
    const read = (event: Root.AgentEvent) => {
      if (event.type === "message.delta") {
        expectTypeOf(event.data).toEqualTypeOf<{ message_id: string; text: string }>();
      }
      switch (event.type) {
        case "run.queued":
        case "run.started":
        case "message.delta":
        case "message.appended":
        case "message.completed":
        case "tool_call.started":
        case "tool_call.completed":
        case "page_action":
        case "run.progress":
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
        case "run.capped":
          return event.seq;
        default: {
          // What is left is the event of a type this version does not know.
          expectTypeOf(event.type).toEqualTypeOf<Root.UnknownName>();
          expectTypeOf(event.data).toEqualTypeOf<Record<string, unknown>>();
          expectTypeOf(event.final).toBeBoolean();
          // Its name is read with String().
          const later: boolean = String(event.type) === "run.waiting";
          // @ts-expect-error So no switch over an event's type is complete.
          assertNever(event);
          return later;
        }
      }
    };
    expectTypeOf(read).toBeFunction();
    expectTypeOf<Root.AgentEvent["final"]>().toEqualTypeOf<boolean>();
  });

  it("a part of a message: of the API's, of a thread's, of the hook's", () => {
    const api = (part: Root.MessagePart) => {
      if (part.type === "text") expectTypeOf(part.text).toBeString();
      switch (part.type) {
        case "text":
          return part.text;
        case "tool_call":
          return part.name;
        default:
          expectTypeOf(part.type).toEqualTypeOf<Root.UnknownName>();
          // @ts-expect-error A part type added later lands here.
          return assertNever(part);
      }
    };
    const shown = (part: ReactEntry.ViewPart) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "tool_call":
          return part.name;
        default:
          // @ts-expect-error A part type added later lands here.
          return assertNever(part);
      }
    };
    expectTypeOf(api).toBeFunction();
    expectTypeOf(shown).toBeFunction();
    expectTypeOf<Convex.ThreadMessage["parts"][number]>().toEqualTypeOf<Root.MessagePart>();
  });

  it("a tool's caller", () => {
    const read = (caller: Convex.ToolCaller) => {
      if (caller.principal === "user") expectTypeOf(caller.tokenIdentifier).toBeString();
      switch (caller.principal) {
        case "user":
          return caller.subject;
        case "agent":
          return caller.agentId;
        default:
          expectTypeOf(caller.principal).toEqualTypeOf<Convex.UnknownName>();
          // @ts-expect-error A kind of caller added later lands here.
          return assertNever(caller);
      }
    };
    expectTypeOf(read).toBeFunction();
    // A handler is typed with the callers its tool lists, and only those.
    expectTypeOf<
      Extract<Convex.ToolCaller, { principal: "user" }>["principal"]
    >().toEqualTypeOf<"user">();
  });
});

describe("sets that are closed, on purpose", () => {
  it("the four statuses a run ends with: that list is the contract", () => {
    const ended = (status: Root.FinalRunStatus, finished: Convex.RunFinished) => {
      expectTypeOf(finished.status).toEqualTypeOf<Root.FinalRunStatus>();
      switch (status) {
        case "completed":
        case "failed":
        case "cancelled":
        case "capped":
          return status;
        default:
          return assertNever(status);
      }
    };
    expectTypeOf(ended).toBeFunction();
  });

  it("how a message's run ended, in the TanStack path: the same four", () => {
    type RunStatus = NonNullable<Tanstack.HerculesMessageMetadata["runStatus"]>;
    expectTypeOf<RunStatus>().toEqualTypeOf<Root.FinalRunStatus>();
  });
});

describe("the thread an app reads and the thread the component returns", () => {
  type Returned = NonNullable<ComponentApi["threads"]["read"]["_returnType"]>;
  type Details = NonNullable<ComponentApi["threads"]["readDetails"]["_returnType"]>;

  it("are the same fields, with the app's value sets open", () => {
    // What the component returns today fits what the app is told to expect.
    expectTypeOf<Returned>().toExtend<Convex.AgentThread>();
    expectTypeOf<Details>().toExtend<Convex.AgentThreadDetails>();
    // Field for field, so neither can gain or lose one alone.
    expectTypeOf<keyof Returned>().toEqualTypeOf<keyof Convex.AgentThread>();
    expectTypeOf<keyof Details>().toEqualTypeOf<keyof Convex.AgentThreadDetails>();
    expectTypeOf<keyof Returned["messages"][number]>().toEqualTypeOf<keyof Convex.ThreadMessage>();
    expectTypeOf<keyof NonNullable<Returned["activeRun"]>>().toEqualTypeOf<
      keyof Convex.ActiveRun
    >();
    expectTypeOf<keyof NonNullable<Returned["latestRun"]>>().toEqualTypeOf<keyof LatestRun>();
    expectTypeOf<keyof Returned["pageActions"][number]>().toEqualTypeOf<
      keyof Convex.PendingPageAction
    >();
    expectTypeOf<keyof Details["toolCalls"][number]>().toEqualTypeOf<keyof Convex.StoredToolCall>();
  });
});
