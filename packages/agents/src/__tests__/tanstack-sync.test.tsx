// @vitest-environment jsdom
import { useChat } from "@tanstack/ai-react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
  return renderHook(
    () => {
      const chat = useChat({ connection, threadId: THREAD, persistence: true });
      const thread = useThreadSync(chat, api.agent.thread, { threadId: THREAD });
      return { chat, thread };
    },
    { wrapper },
  );
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
      { id: "msg_1", role: "assistant", parts: [{ type: "text", content: "Hello!" }] },
    ]);
    expect(syncThread(chat, thread)).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
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
      metadata: { hercules: { runId: RUN, messageStatus: "incomplete" } },
    });
    const marked = chatWith([
      userPart,
      {
        ...streamed("Hello"),
        metadata: { hercules: { runId: RUN, messageStatus: "incomplete" } },
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
