// @vitest-environment jsdom
import { useChat } from "@tanstack/ai-react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { herculesConnection, syncThread, useThreadSync, type SyncableChat } from "../tanstack";
import {
  api,
  assistantMessage,
  createApp,
  frame,
  RUN,
  runningThread,
  settledThread,
  THREAD,
  userMessage,
  type App,
} from "./tanstack-harness";

const OTHER_RUN = "0f4e3d2c-1b0a-4987-8654-3210fedcba98";

function renderChat(app: App) {
  const connection = herculesConnection(app.client, api.agent, { fetch: app.fetch });
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
            finished_at: null,
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
      frame(3, "message.completed", { message: reply }),
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
        settledThread([userMessage("Write a report")], { ...stopped, finished_at: null }),
      );
    });
    await waitFor(() =>
      expect(result.current.chat.messages[1]?.metadata).toMatchObject({
        hercules: { runId: RUN, status: "incomplete" },
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
          { ...stopped, finished_at: null },
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
            finished_at: null,
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

  const streamed = (text: string, status?: string) => ({
    id: "msg_1",
    role: "assistant",
    parts: [{ type: "text", content: text }],
    metadata: { hercules: { runId: RUN, ...(status !== undefined && { status }) } },
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
      { id: RUN, status: "cancelled", error: null, cappedReason: null, finished_at: null },
    );
    const { chat, setMessages } = chatWith([userPart, streamed("Hello")]);
    // Only to mark it: the text is the same.
    expect(syncThread(chat, stored)).toBe(true);
    expect(setMessages.mock.calls[0]?.[0][1]).toMatchObject({
      parts: [{ type: "text", content: "Hello" }],
      metadata: { hercules: { runId: RUN, status: "incomplete" } },
    });
    const marked = chatWith([userPart, streamed("Hello", "incomplete")]);
    expect(syncThread(marked.chat, stored)).toBe(false);
  });

  it("does not keep a reply that finished here, or one that is not how Convex's begins", () => {
    const stored = settledThread(
      [
        userMessage("Hi"),
        assistantMessage("msg_1", [{ type: "text", text: "Hello" }], "incomplete"),
      ],
      { id: RUN, status: "failed", error: null, cappedReason: null, finished_at: null },
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
