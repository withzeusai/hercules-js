// @vitest-environment jsdom
import { useChat } from "@tanstack/ai-react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentThread } from "../agents";
import { syncThread } from "../ag-ui";
import {
  herculesConnection,
  useThreadSync,
  type HerculesConnectionOptions,
  type SyncableChat,
} from "../tanstack";
import {
  api,
  apiMessage,
  assistantMessage,
  createApp,
  frame,
  RUN,
  runningThread,
  settledThread,
  THREAD,
  type App,
  userMessage,
} from "./tanstack-harness";

const OTHER_RUN = "0f4e3d2c-1b0a-4987-8654-3210fedcba98";

function renderChat(app: App, options: HerculesConnectionOptions = {}) {
  const connection = herculesConnection(app.client, api.agent, { fetch: app.fetch, ...options });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ConvexProvider, { client: app.client as unknown as ConvexReactClient }, children);
  // What each render showed: whether the chat was busy, and what each reply said of itself.
  const renders: Array<{ loading: boolean; replies: Record<string, unknown> }> = [];
  const rendered = renderHook(
    () => {
      const chat = useChat({ connection, threadId: THREAD, persistence: true });
      const thread = useThreadSync(chat, api.agent.thread, { threadId: THREAD });
      renders.push({ loading: chat.isLoading, replies: replies(chat.messages) });
      return { chat, thread };
    },
    { wrapper },
  );
  return { ...rendered, renders };
}

function texts(messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>): string[] {
  return messages.map((message) =>
    message.parts
      .map((part) => {
        const p = part as { type: string; content?: string };
        return p.type === "text" ? (p.content ?? "") : "";
      })
      .join(""),
  );
}

type Shown = ReadonlyArray<{
  id: string;
  role: string;
  parts: ReadonlyArray<unknown>;
  metadata?: Record<string, any>;
}>;

/** What `metadata.hercules` says of each reply the chat shows, by message id. */
function replies(messages: Shown): Record<string, unknown> {
  return Object.fromEntries(
    messages
      .filter((message) => message.role === "assistant")
      .map((message) => [message.id, message.metadata?.["hercules"]]),
  );
}

/** What `metadata.hercules` says of the chat's last reply. */
function lastReply(messages: Shown): unknown {
  return Object.values(replies(messages)).at(-1);
}

/** A final event of a type this version does not know: Hercules marks it `final`. */
function unknownEnding(seq: number): string {
  const event = {
    id: `${RUN}:${seq}`,
    seq,
    run_id: RUN,
    thread_id: THREAD,
    type: "run.expired",
    created_at: "2026-11-15T12:00:00.000Z",
    final: true,
    data: {},
  };
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

// A page marks a reply ("Stopped before it finished.", "Stopped.") from
// `metadata.hercules`. What it reads when the run ends has to be what it
// would read after a reload, with no further update of the thread: the
// thread does not change again once the run is over.
describe("a reply when its run ends, live and after a reload", () => {
  const SAID = "Your order is on its way";
  const reply = (text: string, status: "completed" | "incomplete", id = "msg_1") =>
    assistantMessage(id, [{ type: "text", text }], status);
  const latest = (status: string, extra: object = {}): AgentThread["latestRun"] => ({
    id: RUN,
    status,
    error: null,
    cappedReason: null,
    finishedAt: null,
    ...extra,
  });
  const failure = { code: "run_failed", message: "The run failed." };
  const whole = frame(3, "message.completed", { message: apiMessage(reply(SAID, "completed")) });

  const endings = [
    {
      name: "fails while it is writing, with part of the reply in the thread",
      // What the stream sends after the reply's text, and the thread once it has the run's end.
      frames: [frame(3, "run.failed", { error: failure, usage: null })],
      stored: [reply("Your order", "incomplete")],
      latestRun: latest("failed", { error: failure }),
      expected: { runId: RUN, messageStatus: "incomplete", runStatus: "failed" },
    },
    {
      name: "fails while it is writing, with none of the reply in the thread",
      frames: [frame(3, "run.failed", { error: failure, usage: null })],
      stored: [],
      latestRun: latest("failed", { error: failure }),
      expected: { runId: RUN, messageStatus: "incomplete", runStatus: "failed" },
    },
    {
      name: "is stopped, and the thread keeps the reply as far as it was written",
      frames: [whole, frame(4, "run.cancelled", { usage: null })],
      stored: [reply(SAID, "completed")],
      latestRun: latest("cancelled"),
      expected: { runId: RUN, messageStatus: "completed", runStatus: "cancelled" },
    },
    {
      name: "is capped after its reply",
      frames: [whole, frame(4, "run.capped", { capped_reason: "steps", output: null })],
      stored: [reply(SAID, "completed")],
      latestRun: latest("capped", { cappedReason: "steps" }),
      expected: { runId: RUN, messageStatus: "completed", runStatus: "capped" },
    },
    {
      name: "is capped while it is writing",
      frames: [frame(3, "run.capped", { capped_reason: "steps", output: null })],
      stored: [reply("Your order", "incomplete")],
      latestRun: latest("capped", { cappedReason: "steps" }),
      expected: { runId: RUN, messageStatus: "incomplete", runStatus: "capped" },
    },
    {
      name: "ends in a way this version does not know",
      // The component records such an ending as a failure, with what the run wrote.
      frames: [unknownEnding(3)],
      stored: [reply("Your order", "incomplete")],
      latestRun: latest("failed", { error: failure }),
      expected: { runId: RUN, messageStatus: "incomplete", runStatus: "failed" },
    },
    {
      name: "completes",
      frames: [whole, frame(4, "run.completed", { output: SAID, usage: null })],
      stored: [reply(SAID, "completed")],
      latestRun: latest("completed"),
      expected: { runId: RUN, messageStatus: "completed", runStatus: "completed" },
    },
  ];
  const orders = [
    { order: "the stream says so first", streamEnds: true },
    { order: "the thread has it first", streamEnds: false },
  ];
  const cases = endings.flatMap((ending) => orders.map((order) => ({ ...ending, ...order })));

  it.each(cases)(
    "reads the same when the run $name ($order)",
    async ({ frames, stored, latestRun, expected, streamEnds }) => {
      const app = createApp(settledThread([]));
      const { result, renders } = renderChat(app);
      await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
      app.push(
        frame(1, "run.started"),
        frame(2, "message.delta", { message_id: "msg_1", text: SAID }),
        // Without them the stream stays open, and Convex is first to say the run is over.
        ...(streamEnds ? frames : []),
      );
      let sending!: Promise<void>;
      act(() => {
        sending = result.current.chat.sendMessage("Where is my order?");
      });
      await waitFor(() => expect(texts(result.current.chat.messages)[1]).toBe(SAID));
      const sent = renders.length;
      // The thread gets the run's end, once. Nothing updates it again.
      const ended = settledThread([userMessage("Where is my order?"), ...stored], latestRun);
      act(() => app.setThread(ended));
      await act(async () => {
        await sending;
      });
      expect(result.current.chat.isLoading).toBe(false);

      // At the run's end, and in every render since: never a moment where
      // the chat is free and the reply says less, or something else.
      const after = renders.slice(sent).filter((render) => !render.loading);
      expect(after.length).toBeGreaterThan(0);
      for (const render of after) expect(render.replies).toEqual({ msg_1: expected });
      // What this page streamed stays, where the thread holds less of it.
      expect(texts(result.current.chat.messages)).toEqual(["Where is my order?", SAID]);

      // A reload reads the thread and nothing else, and says the same of the reply.
      const reloaded = renderChat(createApp(ended)).result;
      await waitFor(() => expect(reloaded.current.chat.isHydrating).toBe(false));
      await waitFor(() =>
        expect(reloaded.current.chat.messages).toHaveLength(ended.messages.length),
      );
      // The thread has none of this reply to show when it got none of it.
      expect(replies(reloaded.current.chat.messages)).toEqual(
        stored.length === 0 ? {} : { msg_1: expected },
      );
      expect(texts(reloaded.current.chat.messages)).toEqual(
        ended.messages.map((message) =>
          message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ),
      );
    },
  );

  it("reads the same for a run the page stopped, once the thread has its end", async () => {
    const app = createApp(settledThread([]));
    const { result } = renderChat(app);
    await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: SAID }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.chat.sendMessage("Where is my order?");
    });
    await waitFor(() => expect(texts(result.current.chat.messages)[1]).toBe(SAID));
    act(() => result.current.chat.stop());
    await act(async () => {
      await sending;
    });
    // The page stopped reading: the run is the thread's until Hercules has stopped it.
    expect(lastReply(result.current.chat.messages)).toEqual({ runId: RUN });
    const ended = settledThread(
      [userMessage("Where is my order?"), reply(SAID, "completed")],
      latest("cancelled"),
    );
    act(() => app.setThread(ended));
    const expected = { runId: RUN, messageStatus: "completed", runStatus: "cancelled" };
    await waitFor(() => expect(lastReply(result.current.chat.messages)).toEqual(expected));
    const reloaded = renderChat(createApp(ended)).result;
    await waitFor(() => expect(lastReply(reloaded.current.chat.messages)).toEqual(expected));
  });

  it("says each reply's own status when a run with two replies fails in the second", async () => {
    const first = reply("Let me check.", "completed");
    const app = createApp(settledThread([]));
    const { result, renders } = renderChat(app);
    await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Let me check." }),
      frame(3, "message.completed", { message: apiMessage(first) }),
      frame(4, "message.delta", { message_id: "msg_2", text: SAID }),
      frame(5, "run.failed", { error: failure, usage: null }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.chat.sendMessage("Where is my order?");
    });
    await waitFor(() => expect(texts(result.current.chat.messages)[2]).toBe(SAID));
    const ended = settledThread(
      [userMessage("Where is my order?"), first, reply("Your order", "incomplete", "msg_2")],
      latest("failed", { error: failure }),
    );
    act(() => app.setThread(ended));
    await act(async () => {
      await sending;
    });
    const expected = {
      msg_1: { runId: RUN, messageStatus: "completed" },
      msg_2: { runId: RUN, messageStatus: "incomplete", runStatus: "failed" },
    };
    await waitFor(() => expect(replies(result.current.chat.messages)).toEqual(expected));
    expect(texts(result.current.chat.messages)).toEqual([
      "Where is my order?",
      "Let me check.",
      SAID,
    ]);
    // The reply that completed is at no moment said to be cut off.
    for (const render of renders) {
      expect(render.replies["msg_1"]).not.toMatchObject({ messageStatus: "incomplete" });
    }
    const reloaded = renderChat(createApp(ended)).result;
    await waitFor(() => expect(replies(reloaded.current.chat.messages)).toEqual(expected));
  });

  it("says how the run ended at once, and where the thread has the reply once the thread has the run's end", async () => {
    // Convex is behind the stream by more than the chat waits for it.
    const app = createApp(settledThread([]));
    const { result } = renderChat(app, { settleTimeoutMs: 10 });
    await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: SAID }),
      frame(3, "run.failed", { error: failure, usage: null }),
    );
    await act(async () => {
      await result.current.chat.sendMessage("Where is my order?");
    });
    expect(result.current.chat.isLoading).toBe(false);
    expect(lastReply(result.current.chat.messages)).toEqual({ runId: RUN, runStatus: "failed" });
    // A checkpoint of the reply, while the thread still has the run going, changes nothing.
    act(() => {
      app.setThread(
        runningThread([userMessage("Where is my order?"), reply("Your", "incomplete")]),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastReply(result.current.chat.messages)).toEqual({ runId: RUN, runStatus: "failed" });
    act(() => {
      app.setThread(
        settledThread(
          [userMessage("Where is my order?"), reply("Your order", "incomplete")],
          latest("failed", { error: failure }),
        ),
      );
    });
    await waitFor(() =>
      expect(lastReply(result.current.chat.messages)).toEqual({
        runId: RUN,
        messageStatus: "incomplete",
        runStatus: "failed",
      }),
    );
    expect(texts(result.current.chat.messages)).toEqual(["Where is my order?", SAID]);
  });

  it("says how a run ended on its last reply only, and of the thread's latest run only", async () => {
    const earlier = [
      userMessage("Hello", OTHER_RUN),
      assistantMessage("msg_0", [{ type: "text", text: "Hi!" }], "completed", OTHER_RUN),
    ];
    const ended = settledThread(
      [
        ...earlier,
        userMessage("Where is my order?"),
        reply("Let me check.", "completed"),
        reply(SAID, "completed", "msg_2"),
      ],
      latest("cancelled"),
    );
    const { result } = renderChat(createApp(ended));
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(5));
    expect(replies(result.current.chat.messages)).toEqual({
      msg_0: { runId: OTHER_RUN, messageStatus: "completed" },
      msg_1: { runId: RUN, messageStatus: "completed" },
      msg_2: { runId: RUN, messageStatus: "completed", runStatus: "cancelled" },
    });
  });
});

describe("useThreadSync", () => {
  it("shows here a reply another tab got", async () => {
    const app = createApp(
      settledThread([
        userMessage("Hi"),
        assistantMessage("msg_1", [{ type: "text", text: "Hello!" }]),
      ]),
    );
    const { result } = renderChat(app);
    await waitFor(() => expect(texts(result.current.chat.messages)).toEqual(["Hi", "Hello!"]));
    expect(result.current.thread?.id).toBe(THREAD);

    act(() => {
      app.setThread(
        settledThread(
          [
            userMessage("Hi"),
            assistantMessage("msg_1", [{ type: "text", text: "Hello!" }]),
            userMessage("And my order?", OTHER_RUN),
            assistantMessage(
              "msg_2",
              [{ type: "text", text: "It shipped." }],
              "completed",
              OTHER_RUN,
            ),
          ],
          {
            id: OTHER_RUN,
            status: "completed",
            error: null,
            cappedReason: null,
            finishedAt: null,
          },
        ),
      );
    });
    await waitFor(() =>
      expect(texts(result.current.chat.messages)).toEqual([
        "Hi",
        "Hello!",
        "And my order?",
        "It shipped.",
      ]),
    );
  });

  it("follows a run another tab started through every update of the thread", async () => {
    // Two tabs on one thread: the first sends and streams, the second only reads Convex.
    const app = createApp(settledThread([]));
    const sender = renderChat(app).result;
    const reader = renderChat(app).result;
    await waitFor(() => expect(sender.current.chat.isHydrating).toBe(false));
    await waitFor(() => expect(reader.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Opening order 123. One moment." }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = sender.current.chat.sendMessage("Open my order");
    });
    await waitFor(() =>
      expect(texts(sender.current.chat.messages)).toEqual([
        "Open my order",
        "Opening order 123. One moment.",
      ]),
    );
    // The thread's first update of the run: the message that started it.
    await waitFor(() => expect(texts(reader.current.chat.messages)).toEqual(["Open my order"]));
    expect(reader.current.chat.isLoading).toBe(false);

    // Then the reply, a checkpoint at a time.
    const input = userMessage("Open my order");
    for (const text of ["Opening", "Opening order 123."]) {
      act(() => {
        app.setThread(
          runningThread([input, assistantMessage("msg_1", [{ type: "text", text }], "streaming")]),
        );
      });
      await waitFor(() =>
        expect(texts(reader.current.chat.messages)).toEqual(["Open my order", text]),
      );
    }
    // The first message completes, and the run goes on to a second.
    const first = assistantMessage("msg_1", [
      { type: "text", text: "Opening order 123. One moment." },
    ]);
    act(() => app.setThread(runningThread([input, first])));
    await waitFor(() =>
      expect(texts(reader.current.chat.messages)).toEqual([
        "Open my order",
        "Opening order 123. One moment.",
      ]),
    );
    act(() => {
      app.setThread(
        runningThread([
          input,
          first,
          assistantMessage("msg_2", [{ type: "text", text: "It is" }], "streaming"),
        ]),
      );
    });
    await waitFor(() =>
      expect(texts(reader.current.chat.messages)).toEqual([
        "Open my order",
        "Opening order 123. One moment.",
        "It is",
      ]),
    );
    // The tab that streams the run was ahead of Convex all along, and kept what it showed.
    expect(texts(sender.current.chat.messages)).toEqual([
      "Open my order",
      "Opening order 123. One moment.",
    ]);

    const second = assistantMessage("msg_2", [{ type: "text", text: "It is open." }]);
    app.push(
      frame(3, "message.completed", { message: apiMessage(first) }),
      frame(4, "message.completed", { message: apiMessage(second) }),
      frame(5, "run.completed", { output: "It is open.", usage: null }),
    );
    act(() => app.setThread(settledThread([input, first, second])));
    await act(async () => {
      await sending;
    });
    const whole = ["Open my order", "Opening order 123. One moment.", "It is open."];
    await waitFor(() => expect(texts(reader.current.chat.messages)).toEqual(whole));
    expect(texts(sender.current.chat.messages)).toEqual(whole);
    expect(app.callsTo("agent:send")).toHaveLength(1);
  });

  it("keeps what it streamed of a run that Convex still has going, stopped or ended here", async () => {
    // Stopped here: the run is the thread's until Hercules has stopped it.
    const stopped = createApp(settledThread([]));
    const first = renderChat(stopped).result;
    await waitFor(() => expect(first.current.chat.isHydrating).toBe(false));
    stopped.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Here is the first part" }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = first.current.chat.sendMessage("Write a report");
    });
    await waitFor(() => expect(first.current.chat.messages).toHaveLength(2));
    act(() => first.current.chat.stop());
    await act(async () => {
      await sending;
    });
    expect(first.current.chat.isLoading).toBe(false);
    const stopping = runningThread([
      userMessage("Write a report"),
      assistantMessage("msg_1", [{ type: "text", text: "Here is" }], "streaming"),
    ]);
    act(() => {
      stopped.setThread({
        ...stopping,
        activeRun: stopping.activeRun && { ...stopping.activeRun, stopping: true },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(texts(first.current.chat.messages)).toEqual([
      "Write a report",
      "Here is the first part",
    ]);

    // Ended here: the stream brought the run's end, and Convex is behind by
    // more than the chat waits for it.
    const lagging = createApp(settledThread([]));
    const second = renderChat(lagging, { settleTimeoutMs: 10 }).result;
    await waitFor(() => expect(second.current.chat.isHydrating).toBe(false));
    const reply = assistantMessage("msg_1", [{ type: "text", text: "Opening order 123." }]);
    lagging.push(
      frame(1, "run.started"),
      frame(2, "message.completed", { message: apiMessage(reply) }),
      frame(3, "run.completed", { output: "Opening order 123.", usage: null }),
    );
    await act(async () => {
      await second.current.chat.sendMessage("Open my order");
    });
    expect(second.current.chat.isLoading).toBe(false);
    act(() => {
      lagging.setThread(
        runningThread([
          userMessage("Open my order"),
          assistantMessage("msg_1", [{ type: "text", text: "Open" }], "streaming"),
        ]),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(texts(second.current.chat.messages)).toEqual(["Open my order", "Opening order 123."]);
  });

  it("leaves the chat alone while its own reply streams, and after it", async () => {
    const app = createApp(settledThread([]));
    const { result } = renderChat(app);
    await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Opening order 123." }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.chat.sendMessage("Open my order");
    });
    await waitFor(() =>
      expect(texts(result.current.chat.messages)).toEqual(["Open my order", "Opening order 123."]),
    );

    // Convex is behind the live stream: its checkpoint has less of the reply.
    act(() => {
      app.setThread(
        runningThread([
          userMessage("Open my order"),
          assistantMessage("msg_1", [{ type: "text", text: "Open" }], "streaming"),
        ]),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(texts(result.current.chat.messages)).toEqual(["Open my order", "Opening order 123."]);

    const reply = assistantMessage("msg_1", [{ type: "text", text: "Opening order 123." }]);
    app.push(
      frame(3, "message.completed", { message: apiMessage(reply) }),
      frame(4, "run.completed", { output: "Opening order 123.", usage: null }),
    );
    act(() => app.setThread(settledThread([userMessage("Open my order"), reply])));
    await act(async () => {
      await sending;
    });
    expect(result.current.chat.isLoading).toBe(false);
    expect(texts(result.current.chat.messages)).toEqual(["Open my order", "Opening order 123."]);
    expect(app.callsTo("agent:send")).toHaveLength(1);
  });

  it("keeps the reply it streamed when the run is stopped before Convex has all of it", async () => {
    const app = createApp(settledThread([]));
    const { result } = renderChat(app);
    await waitFor(() => expect(result.current.chat.isHydrating).toBe(false));
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Here is the first part" }),
      frame(3, "tool_call.started", { tool_call_id: "call_1", name: "tool", kind: "hercules" }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.chat.sendMessage("Write a report");
    });
    await waitFor(() =>
      expect(result.current.chat.messages[1]?.parts).toContainEqual(
        expect.objectContaining({ type: "tool-call", id: "call_1" }),
      ),
    );
    act(() => result.current.chat.stop());
    await act(async () => {
      await sending;
    });
    expect(result.current.chat.isLoading).toBe(false);

    // The run ends with no checkpoint of the reply: the thread has the user's message only.
    const stopped = { id: RUN, status: "cancelled", error: null, cappedReason: null } as const;
    act(() => {
      app.setThread(
        settledThread([userMessage("Write a report")], { ...stopped, finishedAt: null }),
      );
    });
    await waitFor(() =>
      expect(result.current.chat.messages[1]?.metadata).toMatchObject({
        hercules: { runId: RUN, messageStatus: "incomplete" },
      }),
    );
    expect(texts(result.current.chat.messages)).toEqual([
      "Write a report",
      "Here is the first part",
    ]);
    // The tool call the stop cut off is not left running.
    expect(result.current.chat.messages[1]?.parts).toEqual([
      { type: "text", content: "Here is the first part" },
    ]);

    // A checkpoint delivered after the stop holds less than the page streamed.
    act(() => {
      app.setThread(
        settledThread(
          [
            userMessage("Write a report"),
            assistantMessage("msg_1", [{ type: "text", text: "Here is" }], "incomplete"),
          ],
          { ...stopped, finishedAt: null },
        ),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(texts(result.current.chat.messages)).toEqual([
      "Write a report",
      "Here is the first part",
    ]);

    // It keeps its place when another tab's run adds to the thread.
    act(() => {
      app.setThread(
        settledThread(
          [
            userMessage("Write a report"),
            assistantMessage("msg_1", [{ type: "text", text: "Here is" }], "incomplete"),
            userMessage("Never mind", OTHER_RUN),
            assistantMessage(
              "msg_2",
              [{ type: "text", text: "All right." }],
              "completed",
              OTHER_RUN,
            ),
          ],
          {
            id: OTHER_RUN,
            status: "completed",
            error: null,
            cappedReason: null,
            finishedAt: null,
          },
        ),
      );
    });
    await waitFor(() =>
      expect(texts(result.current.chat.messages)).toEqual([
        "Write a report",
        "Here is the first part",
        "Never mind",
        "All right.",
      ]),
    );
  });
});

function chatWith(messages: SyncableChat["messages"], extra: Partial<SyncableChat> = {}) {
  const setMessages = vi.fn();
  const chat: SyncableChat = { messages, isLoading: false, setMessages, ...extra };
  return { chat, setMessages };
}

describe("syncThread", () => {
  const thread = settledThread([
    userMessage("Hi"),
    assistantMessage("msg_1", [{ type: "text", text: "Hello!" }]),
  ]);

  it("does nothing when the chat already reads the same", () => {
    const { chat, setMessages } = chatWith([
      { id: "local-1", role: "user", parts: [{ type: "text", content: "Hi" }] },
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", content: "Hello!" }],
        // As the stream leaves a reply when its run ends, and as a reload reads it.
        metadata: {
          hercules: { runId: RUN, messageStatus: "completed", runStatus: "completed" },
        },
      },
    ]);
    expect(syncThread(chat, thread)).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();

    // A reply whose metadata says less than the thread does is brought up to it.
    const behind = chatWith([
      { id: "local-1", role: "user", parts: [{ type: "text", content: "Hi" }] },
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", content: "Hello!" }],
        metadata: { hercules: { runId: RUN, runStatus: "completed" } },
      },
    ]);
    expect(syncThread(behind.chat, thread)).toBe(true);
    expect(behind.setMessages.mock.calls[0]?.[0][1]?.metadata).toEqual({
      hercules: { runId: RUN, messageStatus: "completed", runStatus: "completed" },
    });
  });

  it("does nothing while the chat is busy or hydrating", () => {
    expect(syncThread(chatWith([], { isLoading: true }).chat, thread)).toBe(false);
    expect(syncThread(chatWith([], { isHydrating: true }).chat, thread)).toBe(false);
    expect(syncThread(chatWith([]).chat, null)).toBe(false);
  });

  it("does not take Convex's copy of a run this page is showing live", () => {
    const { chat } = chatWith([
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", content: "Hello! How" }],
        metadata: { hercules: { runId: RUN } },
      },
    ]);
    expect(syncThread(chat, runningThread(thread.messages))).toBe(false);
  });

  it("takes every update of a run another tab started, which an earlier sync put here", () => {
    const input = userMessage("Hi");
    const synced = (message: (typeof thread.messages)[number]) => ({
      id: message.id,
      role: message.role,
      parts: message.parts.map((part) => ({
        type: "text",
        content: part.type === "text" ? part.text : "",
      })),
      metadata: { hercules: { runId: message.runId, messageStatus: message.status } },
    });
    // The message that started the run carries the run's id, and is Convex's copy.
    const checkpoint = assistantMessage("msg_1", [{ type: "text", text: "Hel" }], "streaming");
    const afterInput = chatWith([synced(input)]);
    expect(syncThread(afterInput.chat, runningThread([input, checkpoint]))).toBe(true);
    expect(texts(afterInput.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hel"]);
    // So is a checkpoint of the reply, and a message of the run that completed.
    const first = assistantMessage("msg_1", [{ type: "text", text: "Hello!" }]);
    const afterCheckpoint = chatWith([synced(input), synced(checkpoint)]);
    expect(syncThread(afterCheckpoint.chat, runningThread([input, first]))).toBe(true);
    expect(texts(afterCheckpoint.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello!"]);
    const next = assistantMessage("msg_2", [{ type: "text", text: "One" }], "streaming");
    const afterFirst = chatWith([synced(input), synced(first)]);
    expect(syncThread(afterFirst.chat, runningThread([input, first, next]))).toBe(true);
    expect(texts(afterFirst.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello!", "One"]);
  });

  it("does not take Convex's copy of a run whose stream ended here before Convex has its end", () => {
    const ended = (runStatus: string) => ({
      id: "msg_1",
      role: "assistant",
      parts: [{ type: "text", content: "Hello! How are you?" }],
      metadata: { hercules: { runId: RUN, runStatus } },
    });
    const behind = runningThread([
      userMessage("Hi"),
      assistantMessage("msg_1", [{ type: "text", text: "Hello!" }], "streaming"),
    ]);
    for (const status of ["completed", "cancelled", "capped", "failed"]) {
      expect(syncThread(chatWith([ended(status)]).chat, behind)).toBe(false);
      // Nor when Convex has nothing of the reply yet.
      expect(syncThread(chatWith([ended(status)]).chat, runningThread([userMessage("Hi")]))).toBe(
        false,
      );
    }
    // A message Convex holds as completed is the truth, though the run is still its.
    const caughtUp = chatWith([ended("completed")]);
    expect(syncThread(caughtUp.chat, runningThread(thread.messages))).toBe(true);
    expect(texts(caughtUp.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello!"]);
    // The page knows how the run ended before the thread does, and still says so.
    expect(caughtUp.setMessages.mock.calls[0]?.[0][1]?.metadata).toEqual({
      hercules: { runId: RUN, messageStatus: "completed", runStatus: "completed" },
    });
  });

  it("does not take a thread that is behind what the chat already knows of a run's end", () => {
    // The stream ended with the thread's copy of the run's end; this thread is an older one.
    const known = (messageStatus: string, runStatus: string) => ({
      id: "msg_1",
      role: "assistant",
      parts: [{ type: "text", content: "Hello! How are you?" }],
      metadata: { hercules: { runId: RUN, messageStatus, runStatus } },
    });
    const behind = runningThread([
      userMessage("Hi"),
      assistantMessage("msg_1", [{ type: "text", text: "Hello!" }], "streaming"),
    ]);
    for (const [messageStatus, runStatus] of [
      ["incomplete", "failed"],
      ["incomplete", "capped"],
      ["completed", "cancelled"],
      ["completed", "completed"],
    ] as const) {
      const { chat, setMessages } = chatWith([known(messageStatus, runStatus)]);
      expect(syncThread(chat, behind)).toBe(false);
      expect(setMessages).not.toHaveBeenCalled();
    }
  });

  it("keeps the chat's own messages when only what a reply says of itself differs", () => {
    // Two runs this page streamed. Each left how it ended on its reply.
    const said = (id: string, runId: string, text: string) => ({
      id,
      role: "assistant",
      // An argument only the live stream had: the thread does not keep it.
      parts: [{ type: "text", content: text, seenLive: true }],
      metadata: {
        hercules: { runId, messageStatus: "completed", runStatus: "completed" },
        other: "kept",
      },
    });
    const messages = [
      { id: "local-1", role: "user", parts: [{ type: "text", content: "Hi" }] },
      said("msg_0", OTHER_RUN, "Hello!"),
      { id: "local-2", role: "user", parts: [{ type: "text", content: "And now?" }] },
      said("msg_1", RUN, "All done."),
    ];
    const stored = settledThread([
      userMessage("Hi", OTHER_RUN),
      assistantMessage("msg_0", [{ type: "text", text: "Hello!" }], "completed", OTHER_RUN),
      userMessage("And now?"),
      assistantMessage("msg_1", [{ type: "text", text: "All done." }]),
    ]);
    const { chat, setMessages } = chatWith(messages);
    // The thread says how its latest run ended, and of no earlier one: so does the chat now.
    expect(syncThread(chat, stored)).toBe(true);
    const next = setMessages.mock.calls[0]?.[0] as SyncableChat["messages"];
    expect(next.map((message) => message.id)).toEqual(["local-1", "msg_0", "local-2", "msg_1"]);
    expect(next[0]).toBe(messages[0]);
    expect(next[1]?.parts).toBe(messages[1]?.parts);
    expect(next[1]?.metadata).toEqual({
      hercules: { runId: OTHER_RUN, messageStatus: "completed" },
      other: "kept",
    });
    expect(next[3]).toBe(messages[3]);
    expect(syncThread(chatWith(next).chat, stored)).toBe(false);
  });

  it("says how a run ended on the reply it keeps, and not on the one before it", () => {
    const first = assistantMessage("msg_1", [{ type: "text", text: "Let me check." }]);
    const stored = settledThread([userMessage("Hi"), first], {
      id: RUN,
      status: "failed",
      error: { code: "run_failed", message: "The run failed." },
      cappedReason: null,
      finishedAt: null,
    });
    // The thread got none of the second reply, which this page streamed.
    const second = {
      id: "msg_2",
      role: "assistant",
      parts: [{ type: "text", content: "Your order" }],
      metadata: { hercules: { runId: RUN, runStatus: "failed" } },
    };
    const { chat, setMessages } = chatWith([userPart, second]);
    expect(syncThread(chat, stored)).toBe(true);
    const next = setMessages.mock.calls[0]?.[0] as SyncableChat["messages"];
    expect(texts(next)).toEqual(["Hi", "Let me check.", "Your order"]);
    expect(next.map((message) => message.metadata?.["hercules"])).toEqual([
      { runId: RUN, messageStatus: "completed" },
      { runId: RUN, messageStatus: "completed" },
      { runId: RUN, messageStatus: "incomplete", runStatus: "failed" },
    ]);
    // It reads the same on the next update of the thread.
    expect(syncThread(chatWith(next).chat, stored)).toBe(false);

    // Once the thread's latest run is another, the thread says how neither ended.
    const moved = {
      ...stored,
      latestRun: { ...stored.latestRun, id: OTHER_RUN } as typeof stored.latestRun,
    };
    const later = chatWith(next);
    expect(syncThread(later.chat, moved)).toBe(true);
    const after = (later.setMessages.mock.calls[0]?.[0] ?? []) as SyncableChat["messages"];
    expect(after.map((message) => message.metadata?.["hercules"])).toEqual([
      { runId: RUN, messageStatus: "completed" },
      { runId: RUN, messageStatus: "completed" },
      { runId: RUN, messageStatus: "incomplete" },
    ]);
  });

  const streamed = (text: string, runStatus?: string) => ({
    id: "msg_1",
    role: "assistant",
    parts: [{ type: "text", content: text }],
    metadata: { hercules: { runId: RUN, ...(runStatus !== undefined && { runStatus }) } },
  });
  const userPart = { id: "local-1", role: "user", parts: [{ type: "text", content: "Hi" }] };

  it("takes Convex's copy of a reply that completed, whatever the page streamed of it", () => {
    // A step Hercules retried streamed its text twice, and the page then stopped reading.
    const { chat, setMessages } = chatWith([userPart, streamed("Hello!Hello!")]);
    expect(syncThread(chat, thread)).toBe(true);
    expect(texts(setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello!"]);
  });

  it("takes Convex's copy of a cut-off reply that holds as much as the page's", () => {
    const stored = settledThread(
      [
        userMessage("Hi"),
        assistantMessage("msg_1", [{ type: "text", text: "Hello" }], "incomplete"),
      ],
      { id: RUN, status: "cancelled", error: null, cappedReason: null, finishedAt: null },
    );
    const { chat, setMessages } = chatWith([userPart, streamed("Hello")]);
    // Only to mark it: the text is the same.
    expect(syncThread(chat, stored)).toBe(true);
    expect(setMessages.mock.calls[0]?.[0][1]).toMatchObject({
      parts: [{ type: "text", content: "Hello" }],
      metadata: { hercules: { runId: RUN, messageStatus: "incomplete", runStatus: "cancelled" } },
    });
    const marked = chatWith([
      userPart,
      {
        ...streamed("Hello"),
        metadata: {
          hercules: { runId: RUN, messageStatus: "incomplete", runStatus: "cancelled" },
        },
      },
    ]);
    expect(syncThread(marked.chat, stored)).toBe(false);
  });

  it("does not keep a reply that finished here, or one that is not how Convex's begins", () => {
    const stored = settledThread(
      [
        userMessage("Hi"),
        assistantMessage("msg_1", [{ type: "text", text: "Hello" }], "incomplete"),
      ],
      { id: RUN, status: "failed", error: null, cappedReason: null, finishedAt: null },
    );
    const finishedHere = chatWith([userPart, streamed("Hello there, how", "completed")]);
    expect(syncThread(finishedHere.chat, stored)).toBe(true);
    expect(texts(finishedHere.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello"]);
    const another = chatWith([userPart, streamed("Good morning, how")]);
    expect(syncThread(another.chat, stored)).toBe(true);
    expect(texts(another.setMessages.mock.calls[0]?.[0])).toEqual(["Hi", "Hello"]);
  });

  it("keeps messages older than the thread's window", () => {
    const older = { id: "old", role: "user", parts: [{ type: "text", content: "Earlier" }] };
    const { chat, setMessages } = chatWith([
      older,
      { id: `${RUN}:input`, role: "user", parts: [{ type: "text", content: "Hi" }] },
    ]);
    expect(syncThread(chat, { ...thread, hasMore: true })).toBe(true);
    expect(texts(setMessages.mock.calls[0]?.[0])).toEqual(["Earlier", "Hi", "Hello!"]);
  });
});
