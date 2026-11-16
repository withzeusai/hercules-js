import { describe, expect, it } from "vitest";
import type { AgentThread } from "../agents";
import type { AgentEvent } from "../component/protocol";
import { LiveRun, mergeThread } from "../live-thread";

const RUN = "run_1";
const THREAD = "thread_1";

function event(seq: number, type: string, data: unknown = {}): AgentEvent {
  return {
    id: `${RUN}:${seq}`,
    seq,
    run_id: RUN,
    thread_id: THREAD,
    type,
    created_at: "2026-11-15T12:00:00.000Z",
    data,
  } as AgentEvent;
}

function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: THREAD,
    agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
    hasMore: false,
    messages: [
      {
        id: `${RUN}:input`,
        thread_id: THREAD,
        run_id: RUN,
        role: "user",
        parts: [{ type: "text", text: "Hi" }],
        created_at: "2026-11-15T12:00:00.000Z",
        status: "completed",
      },
    ],
    activeRun: {
      id: RUN,
      status: "running",
      progress: null,
      live: { url: "https://api.hercules.test/x", token: "t" },
      lastSeq: 0,
      created_at: "2026-11-15T12:00:00.000Z",
    },
    latestRun: { id: RUN, status: "running", error: null, cappedReason: null, finished_at: null },
    pageActions: [],
    ...overrides,
  };
}

const completed = {
  id: "msg_1",
  thread_id: THREAD,
  run_id: RUN,
  role: "assistant" as const,
  parts: [
    { type: "text" as const, text: "Hello there" },
    {
      type: "tool_call" as const,
      id: "call_1",
      name: "lookup",
      kind: "app" as const,
      status: "succeeded" as const,
      summary: "Looked it up",
    },
  ],
  created_at: "2026-11-15T12:00:01.000Z",
};

describe("mergeThread", () => {
  it("lays the live reply over Convex's, the longer text winning", () => {
    const live = new LiveRun(RUN, THREAD);
    live.apply(event(2, "message.delta", { message_id: "msg_1", text: "Hel" }));
    live.apply(event(3, "message.delta", { message_id: "msg_1", text: "lo" }));
    const stored = thread();
    expect(mergeThread(stored, live, []).map((m) => [m.id, m.status, m.parts])).toEqual([
      [`${RUN}:input`, "completed", [{ type: "text", text: "Hi" }]],
      ["msg_1", "streaming", [{ type: "text", text: "Hello" }]],
    ]);

    // Convex got further than this tab's stream: its text shows.
    stored.messages.push({
      ...completed,
      parts: [{ type: "text", text: "Hello th" }],
      status: "streaming",
    });
    expect(mergeThread(stored, live, [])[1]?.parts).toEqual([{ type: "text", text: "Hello th" }]);
  });

  it("shows tool calls as they run and settle", () => {
    const live = new LiveRun(RUN, THREAD);
    live.apply(
      event(2, "tool_call.started", { tool_call_id: "call_1", name: "lookup", kind: "app" }),
    );
    expect(mergeThread(thread(), live, [])[1]?.parts).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "lookup",
        kind: "app",
        status: "running",
        summary: null,
      },
    ]);
    live.apply(event(3, "message.delta", { message_id: "msg_1", text: "Found it" }));
    live.apply(event(4, "message.completed", { message: completed }));
    const merged = mergeThread(thread(), live, []);
    expect(merged.map((m) => m.id)).toEqual([`${RUN}:input`, "msg_1"]);
    expect(merged[1]).toMatchObject({ status: "completed", parts: completed.parts });
  });

  it("drops the overlay once Convex no longer has the run going", () => {
    const live = new LiveRun(RUN, THREAD);
    live.apply(event(2, "message.delta", { message_id: "msg_1", text: "Hel" }));
    const done = thread({
      activeRun: null,
      messages: [...thread().messages, { ...completed, status: "completed" }],
    });
    expect(mergeThread(done, live, []).map((m) => m.parts)).toEqual([
      [{ type: "text", text: "Hi" }],
      completed.parts,
    ]);
  });

  it("shows the user's message as pending until Convex has it, and never twice", () => {
    const live = new LiveRun(RUN, THREAD);
    live.apply(
      event(2, "message.completed", {
        message: {
          ...completed,
          id: "msg_user",
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
        },
      }),
    );
    const pending = [
      { key: "p1", text: "Next one", runId: null, createdAt: "2026-11-15T12:00:02.000Z" },
    ];
    const merged = mergeThread(thread(), live, pending);
    expect(merged.map((m) => [m.role, m.status])).toEqual([
      ["user", "completed"],
      ["user", "pending"],
    ]);
    // Convex shows the run's input: the pending copy goes.
    expect(mergeThread(thread(), null, [{ ...pending[0]!, runId: RUN }])).toHaveLength(1);
  });

  it("takes a run's ending and a completed message numbered below what it has seen", () => {
    const live = new LiveRun(RUN, THREAD);
    live.apply(event(7, "message.delta", { message_id: "msg_1", text: "Hel" }));
    // Hercules ended the run itself and numbered these after what it had stored.
    expect(live.apply(event(4, "message.completed", { message: completed }))).toBe(true);
    expect(
      live.apply(event(5, "run.failed", { error: { code: "run_failed", message: "x" } })),
    ).toBe(true);
    expect(live.finished).toBe(true);
    expect(live.lastSeq).toBe(7);
    expect(live.view(() => "")[0]).toMatchObject({ status: "completed", parts: completed.parts });
    // Any other event below the last one seen is a repeat.
    expect(live.apply(event(6, "message.delta", { message_id: "msg_1", text: "again" }))).toBe(
      false,
    );
  });

  it("ignores events of other runs and repeats", () => {
    const live = new LiveRun(RUN, THREAD);
    expect(live.apply(event(2, "message.delta", { message_id: "m", text: "a" }))).toBe(true);
    expect(live.apply(event(2, "message.delta", { message_id: "m", text: "a" }))).toBe(false);
    expect(live.apply({ ...event(3, "run.completed"), run_id: "other" } as AgentEvent)).toBe(false);
    expect(live.finished).toBe(false);
  });
});
