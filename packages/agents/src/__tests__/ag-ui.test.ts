import { EventType, StreamProcessor, type StreamChunk } from "@tanstack/ai/client";
import { describe, expect, it, vi } from "vitest";
import {
  PAGE_ACTION_OUTPUT,
  PROGRESS_EVENT,
  RunChunks,
  threadToUIMessages,
  transcriptKey,
} from "../ag-ui";
import type { AgentThread } from "../agents";
import { readAgentEvent, type AgentEvent } from "../component/protocol";

const RUN = "4b1f2c1e-8a8b-4c3f-9d55-0b6f1d2e3a4b";
const THREAD = "9c2d7a10-55e1-4f0b-8d3c-2a1b0c9d8e7f";
const AT = "2026-11-15T12:00:00.000Z";

let seq = 0;
function ev(type: string, data: unknown = {}): AgentEvent {
  seq++;
  const event = readAgentEvent({
    id: `${RUN}:${seq}`,
    seq,
    run_id: RUN,
    thread_id: THREAD,
    type,
    created_at: AT,
    data,
  });
  if (event === null) throw new Error(`unreadable test event ${type}`);
  return event;
}

/** A run that writes, looks something up, sends a page action, and answers. */
function orderRun(): AgentEvent[] {
  seq = 0;
  const reply = {
    id: "msg_1",
    thread_id: THREAD,
    run_id: RUN,
    role: "assistant",
    parts: [
      { type: "text", text: "Let me check." },
      {
        type: "tool_call",
        id: "call_lookup",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
      },
      {
        type: "tool_call",
        id: "call_open",
        name: "open_order",
        kind: "page",
        status: "sent",
        summary: null,
      },
      { type: "text", text: " It shipped." },
    ],
    created_at: AT,
  };
  return [
    ev("run.queued"),
    ev("run.started"),
    ev("message.delta", { message_id: "msg_1", text: "Let me " }),
    ev("message.appended", { message_id: "msg_1", text: "Let me " }),
    ev("message.delta", { message_id: "msg_1", text: "check." }),
    ev("tool_call.started", { tool_call_id: "call_lookup", name: "lookup_order", kind: "app" }),
    ev("run.progress", { label: "Looking up your order" }),
    ev("tool_call.completed", {
      tool_call_id: "call_lookup",
      name: "lookup_order",
      kind: "app",
      status: "succeeded",
      summary: "Looked up order 123",
      result: { id: "123" },
    }),
    ev("tool_call.started", { tool_call_id: "call_open", name: "open_order", kind: "page" }),
    ev("tool_call.completed", {
      tool_call_id: "call_open",
      name: "open_order",
      kind: "page",
      status: "sent",
      summary: null,
    }),
    ev("page_action", {
      tool_call_id: "call_open",
      name: "open_order",
      arguments: { orderId: "123" },
    }),
    ev("message.delta", { message_id: "msg_1", text: " It shipped." }),
    ev("message.completed", { message: reply }),
    ev("run.completed", { output: "Let me check. It shipped.", usage: { credits: 1 } }),
  ];
}

function translate(events: AgentEvent[]): StreamChunk[] {
  const run = new RunChunks(THREAD, RUN);
  return [run.started(), ...events.flatMap((event) => run.apply(event)), ...run.finish()];
}

function settledThread(): AgentThread {
  const events = orderRun();
  const completed = events.find((event) => event.type === "message.completed");
  if (completed?.type !== "message.completed") throw new Error("no completed message");
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
        parts: [{ type: "text", text: "Where is my order?" }],
        created_at: AT,
        status: "completed",
      },
      { ...completed.data.message, status: "completed" },
    ],
    activeRun: null,
    latestRun: { id: RUN, status: "completed", error: null, cappedReason: null, finished_at: null },
    pageActions: [],
  };
}

describe("RunChunks", () => {
  it("starts with RUN_STARTED, ends with one RUN_FINISHED, and writes the text once", () => {
    const chunks = translate(orderRun());
    expect(chunks[0]).toMatchObject({ type: "RUN_STARTED", threadId: THREAD, runId: RUN });
    const terminals = chunks.filter((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR");
    expect(terminals).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      runId: RUN,
      finishReason: "stop",
      outcome: { type: "success" },
    });
    const text = chunks.flatMap((c) => (c.type === "TEXT_MESSAGE_CONTENT" ? [c.delta] : []));
    // The appended checkpoint repeats the deltas; it adds nothing.
    expect(text.join("")).toBe("Let me check. It shipped.");
  });

  it("answers every tool call in the stream, the page action with 'sent to the page'", () => {
    const chunks = translate(orderRun());
    const results = chunks.flatMap((c) => (c.type === "TOOL_CALL_RESULT" ? [c] : []));
    expect(results.map((r) => [r.toolCallId, JSON.parse(r.content as string)])).toEqual([
      ["call_lookup", { kind: "app", status: "succeeded", summary: "Looked up order 123" }],
      ["call_open", PAGE_ACTION_OUTPUT],
    ]);
    // The page action's arguments come before its end.
    const open = chunks.filter((c) => "toolCallId" in c && c.toolCallId === "call_open");
    expect(open.map((c) => c.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    expect(open[1]).toMatchObject({ delta: JSON.stringify({ orderId: "123" }) });
  });

  it("passes run.progress on as a custom event", () => {
    const chunks = translate(orderRun());
    expect(chunks.find((c) => c.type === "CUSTOM")).toMatchObject({
      name: PROGRESS_EVENT,
      value: { label: "Looking up your order" },
    });
  });

  it("builds in TanStack the same transcript a reload hydrates, with no tool left to run", () => {
    const onToolCall = vi.fn();
    const processor = new StreamProcessor({ events: { onToolCall } });
    for (const chunk of translate(orderRun())) processor.processChunk(chunk);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(processor.areAllToolsComplete()).toBe(true);

    const streamed = processor.getMessages();
    const hydrated = threadToUIMessages(settledThread()).filter((m) => m.role === "assistant");
    expect(transcriptKey(streamed)).toBe(transcriptKey(hydrated));
    expect(streamed[0]?.metadata?.["hercules"]).toEqual({ runId: RUN, status: "completed" });
    // Only the live stream has a page action's arguments.
    const open = streamed[0]?.parts.find((p) => p.type === "tool-call" && p.id === "call_open");
    expect(open).toMatchObject({ input: { orderId: "123" }, output: PAGE_ACTION_OUTPUT });
  });

  it("writes text that went past the stream when the message completes", () => {
    seq = 0;
    const run = new RunChunks(THREAD, RUN);
    run.apply(ev("message.delta", { message_id: "m", text: "Hel" }));
    const chunks = run.apply(
      ev("message.completed", {
        message: {
          id: "m",
          thread_id: THREAD,
          run_id: RUN,
          role: "assistant",
          parts: [{ type: "text", text: "Hello there" }],
          created_at: AT,
        },
      }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    expect(chunks[0]).toMatchObject({ delta: "lo there" });
  });

  it("skips the user's own message and events it has seen", () => {
    seq = 0;
    const run = new RunChunks(THREAD, RUN);
    const delta = ev("message.delta", { message_id: "m", text: "Hi" });
    expect(run.apply(delta)).toHaveLength(2);
    expect(run.apply(delta)).toEqual([]);
    const user = ev("message.completed", {
      message: {
        id: `${RUN}:input`,
        thread_id: THREAD,
        run_id: RUN,
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        created_at: AT,
      },
    });
    expect(run.apply(user)).toEqual([]);
  });

  it("ends a failed run with RUN_ERROR and its code, and answers tool calls left open", () => {
    seq = 0;
    const run = new RunChunks(THREAD, RUN);
    run.apply(ev("tool_call.started", { tool_call_id: "c", name: "web_search", kind: "hercules" }));
    run.apply(ev("run.failed", { error: { code: "out_of_credits", message: "No credits left." } }));
    const chunks = run.finish();
    expect(chunks.map((c) => c.type)).toEqual(["TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_ERROR"]);
    expect(chunks.at(-1)).toMatchObject({ code: "out_of_credits", message: "No credits left." });
    expect(run.finish()).toEqual([]);
  });

  it("answers a page action at the run's end when its arguments never came", () => {
    seq = 0;
    const run = new RunChunks(THREAD, RUN);
    run.apply(
      ev("tool_call.completed", {
        tool_call_id: "call_open",
        name: "open_order",
        kind: "page",
        status: "sent",
        summary: null,
      }),
    );
    run.apply(ev("run.completed", { output: null, usage: null }));
    const chunks = run.finish();
    expect(chunks.map((c) => c.type)).toEqual([
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    expect(chunks[1]).toMatchObject({ content: JSON.stringify(PAGE_ACTION_OUTPUT) });
  });

  it("ends a cancelled run with a cancelled outcome", () => {
    seq = 0;
    const run = new RunChunks(THREAD, RUN);
    run.apply(ev("run.cancelled", { usage: null }));
    expect(run.finish()).toEqual([
      expect.objectContaining({ type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } }),
    ]);
  });

  it("catches up from Convex when the stream brought nothing", () => {
    const run = new RunChunks(THREAD, RUN);
    const chunks = [...run.reconcile(settledThread()), ...run.finish()];
    const processor = new StreamProcessor({});
    processor.processChunk(run.started());
    for (const chunk of chunks) processor.processChunk(chunk);
    const hydrated = threadToUIMessages(settledThread()).filter((m) => m.role === "assistant");
    expect(transcriptKey(processor.getMessages())).toBe(transcriptKey(hydrated));
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  });

  it("takes a failed run's error from Convex", () => {
    const run = new RunChunks(THREAD, RUN);
    run.reconcile({
      ...settledThread(),
      messages: [],
      latestRun: {
        id: RUN,
        status: "failed",
        error: { code: "agent_disabled", message: "The agent is off." },
        cappedReason: null,
        finished_at: null,
      },
    });
    expect(run.finish().at(-1)).toMatchObject({ type: "RUN_ERROR", code: "agent_disabled" });
  });
});

describe("threadToUIMessages", () => {
  it("leaves out a reply that has written nothing yet, and marks failed tool calls", () => {
    const thread = settledThread();
    const messages = threadToUIMessages({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: "msg_2",
          thread_id: THREAD,
          run_id: RUN,
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "c",
              name: "web_search",
              kind: "hercules",
              status: "failed",
              summary: "No results",
            },
          ],
          created_at: AT,
          status: "completed",
        },
        {
          id: "msg_3",
          thread_id: THREAD,
          run_id: RUN,
          role: "assistant",
          parts: [],
          created_at: AT,
          status: "streaming",
        },
      ],
    });
    expect(messages.map((m) => m.id)).toEqual([`${RUN}:input`, "msg_1", "msg_2"]);
    expect(messages[2]?.parts[0]).toMatchObject({ type: "tool-call", state: "error" });
    expect(messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", content: "Where is my order?" }],
      createdAt: new Date(AT),
      metadata: { hercules: { runId: RUN, status: "completed" } },
    });
  });
});
