/**
 * The naming rule at run time: what the package builds for the app carries
 * no snake_case field name. `naming.test-d.ts` holds the same rule in the
 * types, and lists the only exemptions, the Hercules API's own JSON.
 *
 * Checked here: the validators that say what the component returns and what
 * `onRunFinished` is called with, field by field, and the messages each
 * hook builds from a run's live events, which arrive under the API's names.
 */
import type { GenericValidator } from "convex/values";
import { describe, expect, it } from "vitest";
import { threadToUIMessages } from "../ag-ui";
import type { AgentThread } from "../agents";
import { readAgentEvent, type AgentEvent } from "../component/protocol";
import { vThread, vThreadDetails } from "../component/validators";
import { runFinishedValidator } from "../convex";
import { LiveRun, mergeThread } from "../live-thread";

const SNAKE = /[A-Za-z0-9]_[A-Za-z0-9]/;

/** Every field name a validator declares, at every depth, as a path. */
function declaredNames(validator: GenericValidator, path = ""): string[] {
  switch (validator.kind) {
    case "object":
      return Object.entries(validator.fields).flatMap(([name, field]) => [
        `${path}.${name}`,
        ...declaredNames(field, `${path}.${name}`),
      ]);
    case "array":
      return declaredNames(validator.element, `${path}[]`);
    case "record":
      return declaredNames(validator.value, `${path}{}`);
    case "union":
      return validator.members.flatMap((member) => declaredNames(member, path));
    default:
      return [];
  }
}

/** Every key of a value, at every depth, as a path. Strings are not looked into. */
function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => keysOf(entry, `${path}[]`));
  if (typeof value !== "object" || value === null || value instanceof Date) return [];
  return Object.entries(value).flatMap(([name, entry]) => [
    `${path}.${name}`,
    ...keysOf(entry, `${path}.${name}`),
  ]);
}

function snake(names: string[]): string[] {
  return names.filter((name) => SNAKE.test(name.slice(name.lastIndexOf(".") + 1)));
}

const THREAD = "thr_1";
const RUN = "run_1";
const AT = "2026-11-15T12:00:00.000Z";

/** An event as Hercules sends it, read as the package reads the live stream. */
function event(seq: number, type: string, data: unknown): AgentEvent {
  const read = readAgentEvent({
    id: `${RUN}:${seq}`,
    seq,
    run_id: RUN,
    thread_id: THREAD,
    type,
    created_at: AT,
    data,
  });
  if (read === null) throw new Error(`unreadable event ${type}`);
  return read;
}

const thread: AgentThread = {
  id: THREAD,
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  hasMore: false,
  messages: [
    {
      id: `${RUN}:input`,
      threadId: THREAD,
      runId: RUN,
      role: "user",
      parts: [{ type: "text", text: "Where is my order?" }],
      createdAt: AT,
      status: "completed",
    },
  ],
  activeRun: {
    id: RUN,
    status: "running",
    progress: null,
    live: null,
    lastSeq: 0,
    createdAt: AT,
    stopping: false,
  },
  latestRun: { id: RUN, status: "running", error: null, cappedReason: null, finishedAt: null },
  pageActions: [],
};

describe("what the component returns and the app is called with", () => {
  it("declares no snake_case field: the thread, its details, and a finished run", () => {
    for (const validator of [vThread, vThreadDetails, runFinishedValidator]) {
      const names = declaredNames(validator);
      // The walk reached the nested fields, so an empty answer means something.
      expect(names.length).toBeGreaterThan(8);
      expect(snake(names)).toEqual([]);
    }
    expect(declaredNames(vThread)).toContain(".messages[].createdAt");
    expect(declaredNames(vThread)).toContain(".latestRun.finishedAt");
    expect(declaredNames(vThreadDetails)).toContain(".toolCalls[].createdAt");
  });
});

describe("what the hooks build from the API's events", () => {
  const completed = event(4, "message.completed", {
    message: {
      id: "msg_1",
      thread_id: THREAD,
      run_id: RUN,
      role: "assistant",
      parts: [
        { type: "text", text: "It shipped." },
        {
          type: "tool_call",
          id: "call_1",
          name: "lookup_order",
          kind: "app",
          status: "succeeded",
          summary: null,
        },
      ],
      created_at: AT,
    },
  });

  it("has no snake_case key in useAgentThread's messages, streaming or completed", () => {
    const streaming = new LiveRun(RUN, THREAD);
    streaming.apply(event(2, "message.delta", { message_id: "msg_1", text: "It " }));
    streaming.apply(
      event(3, "tool_call.started", { tool_call_id: "call_1", name: "x", kind: "app" }),
    );
    const done = new LiveRun(RUN, THREAD);
    done.apply(completed);
    for (const live of [streaming, done]) {
      const messages = mergeThread(thread, live, [
        { key: "pending:1", text: "And the next one?", runId: null, createdAt: AT },
      ]);
      expect(messages.length).toBe(3);
      expect(snake(keysOf(messages))).toEqual([]);
    }
  });

  it("has no snake_case key in the metadata the TanStack path puts on a message", () => {
    const messages = threadToUIMessages(thread);
    expect(messages[0]?.metadata).toEqual({
      hercules: { runId: RUN, messageStatus: "completed" },
    });
    expect(snake(keysOf(messages))).toEqual([]);
  });

  it("finds one where there is one: the API's event keeps the API's names", () => {
    expect(snake(keysOf(completed))).toEqual([
      ".run_id",
      ".thread_id",
      ".created_at",
      ".data.message.thread_id",
      ".data.message.run_id",
      ".data.message.created_at",
    ]);
  });
});
