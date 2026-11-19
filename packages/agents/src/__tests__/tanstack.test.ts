import { toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai/client";
import { ChatClient } from "@tanstack/ai-client";
import { describe, expect, it, vi } from "vitest";
import { PAGE_ACTION_OUTPUT, threadToUIMessages, transcriptKey } from "../ag-ui";
import { AgentError } from "../errors";
import { agentErrorCode, herculesConnection, type HerculesConnectionOptions } from "../tanstack";
import {
  api,
  assistantMessage,
  createApp,
  frame,
  LIVE_URL,
  pendingPageAction,
  RUN,
  runningThread,
  settledThread,
  THREAD,
  userMessage,
  type App,
} from "./tanstack-harness";

const STOPPED_RUN = "0f4e3d2c-1b0a-4987-8654-3210fedcba98";

const REPLY = assistantMessage("msg_1", [
  { type: "text", text: "Opening order 123." },
  {
    type: "tool_call",
    id: "call_open",
    name: "open_order",
    kind: "page",
    status: "sent",
    summary: null,
  },
]);

/** The events of a run that writes a line, sends a page action, and finishes. */
function pageActionRun(): string[] {
  return [
    frame(1, "run.queued"),
    frame(2, "run.started"),
    frame(3, "message.delta", { message_id: "msg_1", text: "Opening order 123." }),
    frame(4, "tool_call.started", { tool_call_id: "call_open", name: "open_order", kind: "page" }),
    frame(5, "page_action", {
      tool_call_id: "call_open",
      name: "open_order",
      arguments: { orderId: "123" },
    }),
    frame(6, "tool_call.completed", {
      tool_call_id: "call_open",
      name: "open_order",
      kind: "page",
      status: "sent",
      summary: null,
    }),
    frame(7, "message.completed", { message: REPLY }),
    frame(8, "run.completed", { output: "Opening order 123.", usage: { credits: 1 } }),
  ];
}

function chatFor(app: App, options: HerculesConnectionOptions = {}, extra: object = {}) {
  const chunks: StreamChunk[] = [];
  const connection = herculesConnection(app.client, api.agent, { fetch: app.fetch, ...options });
  const chat = new ChatClient({
    connection,
    threadId: THREAD,
    onChunk: (chunk: StreamChunk) => chunks.push(chunk),
    ...extra,
  });
  return { chat, chunks, connection };
}

/** Convex has the run's end, as the component writes it once Hercules delivers it. */
function deliverEnd(app: App) {
  app.setThread(settledThread([userMessage("Open my order"), REPLY]));
}

describe("herculesConnection", () => {
  it("a run with a page action ends with RUN_FINISHED and no continuation", async () => {
    const app = createApp();
    const openOrder = vi.fn();
    // The page also has a TanStack client tool by that name: it must not run either.
    const clientOpenOrder = vi.fn(() => ({ opened: true }));
    const { chat, chunks } = chatFor(
      app,
      { pageActions: { open_order: openOrder } },
      {
        tools: [
          toolDefinition({ name: "open_order", description: "Opens an order" }).client(
            clientOpenOrder,
          ),
        ],
      },
    );

    app.push(...pageActionRun());
    const sending = chat.sendMessage("Open my order");
    // The live stream shows the page action in the chat. It is run once Hercules
    // has delivered it to the app, which is when it can be claimed.
    await vi.waitFor(() => expect(chunks.some((c) => c.type === "TOOL_CALL_RESULT")).toBe(true));
    expect(app.callsTo("agent:claimPageAction")).toEqual([]);
    expect(openOrder).not.toHaveBeenCalled();
    app.deliverPageAction(pendingPageAction("call_open", { orderId: "123" }));
    await vi.waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(openOrder).toHaveBeenCalledWith(
      { orderId: "123" },
      { toolCallId: "call_open", runId: RUN },
    );
    expect(app.callsTo("agent:claimPageAction")).toEqual([
      {
        name: "agent:claimPageAction",
        args: { threadId: THREAD, runId: RUN, toolCallId: "call_open" },
      },
    ]);

    deliverEnd(app);
    await sending;
    // Any continuation TanStack would start, it starts right after the run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const terminals = chunks.filter((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR");
    expect(terminals).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId: RUN });
    expect(app.callsTo("agent:send")).toHaveLength(1);
    expect(clientOpenOrder).not.toHaveBeenCalled();
    expect(chat.getStatus()).toBe("ready");
    expect(chat.getError()).toBeUndefined();

    const [user, reply] = chat.getMessages();
    expect(user).toMatchObject({
      role: "user",
      parts: [{ type: "text", content: "Open my order" }],
    });
    expect(reply?.parts).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        id: "call_open",
        state: "complete",
        input: { orderId: "123" },
        output: PAGE_ACTION_OUTPUT,
      }),
    );
    expect(app.watching()).toBe(0);
  });

  it("shows the completed reply, once, when a retried step streamed its text twice", async () => {
    const app = createApp(
      settledThread(
        [
          userMessage("Hello", "run_earlier"),
          assistantMessage("msg_0", [{ type: "text", text: "Hi!" }], "completed", "run_earlier"),
        ],
        {
          id: "run_earlier",
          status: "completed",
          error: null,
          cappedReason: null,
          finished_at: null,
        },
      ),
    );
    const { chat, chunks } = chatFor(app, {}, { persistence: true });
    chat.attach();
    await vi.waitFor(() => expect(chat.getMessages()).toHaveLength(2));

    const reply = assistantMessage("msg_1", [{ type: "text", text: "Your order shipped today." }]);
    app.push(
      frame(1, "run.queued"),
      frame(2, "run.started"),
      // The step fails here, and Hercules runs it again from its start.
      frame(3, "message.delta", { message_id: "msg_1", text: "Your order is on " }),
      frame(4, "message.delta", { message_id: "msg_1", text: "Your order shipped " }),
      frame(5, "message.delta", { message_id: "msg_1", text: "today." }),
      frame(6, "message.completed", { message: reply }),
      frame(7, "run.completed", { output: "Your order shipped today.", usage: null }),
    );
    const sending = chat.sendMessage("Where is my order?");
    const texts = () =>
      chat
        .getMessages()
        .map((m) => m.parts.map((part) => (part.type === "text" ? part.content : "")).join(""));
    // The completed message corrects the chat before Convex has the run's end.
    await vi.waitFor(() =>
      expect(texts()).toEqual(["Hello", "Hi!", "Where is my order?", "Your order shipped today."]),
    );
    expect(chat.getIsLoading()).toBe(true);
    app.setThread(settledThread([...(app.thread()?.messages ?? []), reply]));
    await sending;

    expect(texts()).toEqual(["Hello", "Hi!", "Where is my order?", "Your order shipped today."]);
    expect(chat.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(chat.getStatus()).toBe("ready");
    expect(chat.getError()).toBeUndefined();
    expect(chunks.filter((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR")).toHaveLength(
      1,
    );
    // The chat reads as the thread does: there is nothing left for `useThreadSync` to fix.
    expect(transcriptKey(chat.getMessages())).toBe(transcriptKey(threadToUIMessages(app.thread())));
    chat.dispose();
  });

  it("finishes from Convex when the live stream stalls without the run's ending", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    // The stream brings part of the reply and then nothing: no ending, and it stays open.
    app.push(
      frame(1, "run.queued"),
      frame(2, "run.started"),
      frame(3, "message.delta", { message_id: "msg_1", text: "Opening " }),
    );
    const sending = chat.sendMessage("Open my order");
    await vi.waitFor(() =>
      expect(chunks.some((c) => c.type === "TEXT_MESSAGE_CONTENT")).toBe(true),
    );
    expect(chat.getIsLoading()).toBe(true);

    // Hercules delivered the reply and the run's end to the app meanwhile.
    const startedAt = Date.now();
    deliverEnd(app);
    await sending;
    // At once: not after ten failed reconnects, and with no settle timeout.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId: RUN });
    expect(chat.getStatus()).toBe("ready");
    expect(chat.getError()).toBeUndefined();
    const reply = chat.getMessages().at(-1);
    expect(reply?.parts[0]).toEqual({ type: "text", content: "Opening order 123." });
    expect(app.watching()).toBe(0);
    expect(app.fetchUrls).toHaveLength(1);
  });

  it("ends a run that finished as finished when the thread already has a newer run", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    // The stream brings the reply but not yet the ending when Convex has both.
    app.push(
      frame(1, "run.queued"),
      frame(2, "run.started"),
      frame(3, "message.delta", { message_id: "msg_1", text: "Opening order 123." }),
    );
    const sending = chat.sendMessage("Open my order");
    await vi.waitFor(() =>
      expect(chunks.some((c) => c.type === "TEXT_MESSAGE_CONTENT")).toBe(true),
    );
    // The run is over in Convex, and the app's `onRunFinished` has already
    // started a follow-up on the thread: `latestRun` is that one.
    const followUp = "7c1f2c1e-8a8b-4c3f-9d55-0b6f1d2e3a4c";
    app.setThread({
      ...runningThread(
        [userMessage("Open my order"), REPLY, userMessage("Summarize it", followUp)],
        followUp,
      ),
    });
    await sending;
    // It used to end with RUN_ERROR "The run ended without saying how."
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId: RUN });
    expect(chunks.some((c) => c.type === "RUN_ERROR")).toBe(false);
    expect(chat.getError()).toBeUndefined();
    expect(chat.getStatus()).toBe("ready");
    expect(chat.getMessages()[1]?.parts[0]).toEqual({
      type: "text",
      content: "Opening order 123.",
    });
  });

  it("takes the run's ending from the stream though it is numbered below what was read", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    const reply = assistantMessage("msg_1", [{ type: "text", text: "Opening" }]);
    app.push(
      frame(1, "run.queued"),
      frame(2, "run.started"),
      frame(9, "message.delta", { message_id: "msg_1", text: "Opening" }),
      // Hercules ended the run itself, and numbered what it stored after the
      // last event it had stored, which is below what the stream had sent.
      frame(5, "message.completed", { message: reply }),
      frame(6, "run.failed", { error: { code: "run_failed", message: "The run was ended." } }),
    );
    const sending = chat.sendMessage("Open my order");
    // The ending was read off the stream: the chat only waits for Convex to have it.
    await vi.waitFor(() => expect(app.fetchUrls).toHaveLength(1));
    app.setThread(
      settledThread([userMessage("Open my order"), reply], {
        id: RUN,
        status: "failed",
        error: { code: "run_failed", message: "The run was ended." },
        cappedReason: null,
        finished_at: null,
      }),
    );
    await sending;
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "run_failed" });
    expect(agentErrorCode(chat.getError())).toBe("run_failed");
    expect(chat.getMessages().at(-1)?.parts[0]).toEqual({ type: "text", content: "Opening" });
  });

  it("does not claim or run a page action the thread lists as expired", async () => {
    const app = createApp({
      ...settledThread([userMessage("Open my order"), REPLY]),
      // It reached the app more than two minutes after the agent called it.
      pageActions: [{ ...pendingPageAction("call_late", {}), status: "expired" }],
    });
    const openOrder = vi.fn();
    const connection = herculesConnection(app.client, api.agent, {
      fetch: app.fetch,
      pageActions: { open_order: openOrder },
    });
    await connection.hydrate(THREAD);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.callsTo("agent:claimPageAction")).toEqual([]);
    expect(openOrder).not.toHaveBeenCalled();
  });

  it("sends the page's thread id and context, and streams from the run's live URL", async () => {
    const app = createApp();
    const { chat } = chatFor(app);
    app.push(...pageActionRun());
    // As useChat's `sendMessage(text, { body })` passes it.
    const sending = chat.sendMessage("Open my order", undefined, {
      body: { context: { page: "/orders" } },
    });
    await vi.waitFor(() => expect(app.fetchUrls).toHaveLength(1));
    deliverEnd(app);
    await sending;

    expect(app.callsTo("agent:send")[0]?.args).toEqual({
      threadId: THREAD,
      text: "Open my order",
      context: { page: "/orders" },
    });
    expect(app.fetchUrls[0]).toBe(LIVE_URL);
    expect(app.fetchHeaders[0]?.get("authorization")).toBe("Bearer run-token");
    expect(app.callsTo("watch agent:thread")[0]?.args).toEqual({ threadId: THREAD });
  });

  it("is ready for the next message only once Convex has the run's end", async () => {
    const app = createApp();
    const { chat } = chatFor(app);
    app.push(...pageActionRun());
    const sending = chat.sendMessage("Open my order");
    await vi.waitFor(() =>
      expect(chat.getMessages().at(-1)?.parts).toContainEqual(
        expect.objectContaining({ id: "call_open", state: "complete" }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chat.getIsLoading()).toBe(true);
    deliverEnd(app);
    await sending;
    expect(chat.getIsLoading()).toBe(false);
  });

  it("finishes anyway when Convex lags past the settle timeout", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app, { settleTimeoutMs: 30 });
    app.push(...pageActionRun());
    await chat.sendMessage("Open my order");
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(chat.getStatus()).toBe("ready");
  });

  it("puts the code of why a message was not sent on chat.error", async () => {
    const app = createApp();
    app.failSendWith("thread_busy", "The agent is still answering in this thread.");
    const { chat } = chatFor(app);
    await chat.sendMessage("Hello");
    const error = chat.getError();
    expect(error?.message).toBe("The agent is still answering in this thread.");
    expect(agentErrorCode(error)).toBe("thread_busy");
    expect(chat.getStatus()).toBe("error");
    expect(app.fetchUrls).toHaveLength(0);
  });

  it("ends a failed run with RUN_ERROR and the run's error code", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    app.push(
      frame(1, "run.started"),
      frame(2, "run.failed", { error: { code: "out_of_credits", message: "No credits left." } }),
    );
    const sending = chat.sendMessage("Hello");
    await vi.waitFor(() => expect(app.fetchUrls).toHaveLength(1));
    app.setThread(
      settledThread([userMessage("Hello")], {
        id: RUN,
        status: "failed",
        error: { code: "out_of_credits", message: "No credits left." },
        cappedReason: null,
        finished_at: null,
      }),
    );
    await sending;
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "out_of_credits" });
    expect(chat.getStatus()).toBe("error");
    expect(chat.getError()).toMatchObject({ message: "No credits left.", code: "out_of_credits" });
  });

  it("reads the reply from Convex when Hercules refuses the live stream", async () => {
    const app = createApp();
    app.answerStreamWith(() => Response.json({ code: "invalid_run_token" }, { status: 401 }));
    const { chat, chunks } = chatFor(app);
    const sending = chat.sendMessage("Open my order");
    await vi.waitFor(() => expect(app.fetchUrls).toHaveLength(1));
    deliverEnd(app);
    await sending;
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(chat.getMessages().at(-1)?.parts[0]).toEqual({
      type: "text",
      content: "Opening order 123.",
    });
    expect(chat.getError()).toBeUndefined();
  });

  it("finishes from Convex a run that ended before it could be streamed", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    // Hercules refused the run when the component started it: it never went live.
    const send = app.client.mutation.bind(app.client);
    app.client.mutation = async (reference, args) => {
      const started = await send(reference, args);
      app.setThread(
        settledThread([userMessage("Hello")], {
          id: RUN,
          status: "failed",
          error: { code: "agent_disabled", message: "The agent is off." },
          cappedReason: null,
          finished_at: null,
        }),
      );
      return started;
    };
    await chat.sendMessage("Hello");
    expect(app.fetchUrls).toHaveLength(0);
    expect(chunks.map((c) => c.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    expect(chat.getError()).toMatchObject({ code: "agent_disabled" });
  });

  it("stops the run with the cancel mutation when the chat stops", async () => {
    const app = createApp();
    const { chat } = chatFor(app);
    app.push(frame(1, "run.started"), frame(2, "message.delta", { message_id: "m", text: "Hel" }));
    void chat.sendMessage("Hello");
    await vi.waitFor(() => expect(chat.getMessages()).toHaveLength(2));
    chat.stop();
    await vi.waitFor(() => expect(app.callsTo("agent:cancel")).toHaveLength(1));
    expect(app.callsTo("agent:cancel")[0]?.args).toEqual({ threadId: THREAD });
    await vi.waitFor(() => expect(chat.getIsLoading()).toBe(false));
    await vi.waitFor(() => expect(app.watching()).toBe(0));
  });

  it("keeps the chat running while a run waits in a state it does not know, and can stop it", async () => {
    const app = createApp();
    const { chat, chunks } = chatFor(app);
    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Let me check." }),
      // The run now waits for a person: an event and a status added later.
      frame(3, "run.requires_action", { action: { type: "approval" } }),
    );
    const sending = chat.sendMessage("Refund my order");
    await vi.waitFor(() =>
      expect(chunks.some((c) => c.type === "TEXT_MESSAGE_CONTENT")).toBe(true),
    );
    // Convex still has the run going, so the chat does: no end, and no error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.getIsLoading()).toBe(true);
    expect(chat.getError()).toBeUndefined();
    expect(chunks.some((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR")).toBe(false);

    chat.stop();
    await vi.waitFor(() => expect(app.callsTo("agent:cancel")).toHaveLength(1));
    expect(app.callsTo("agent:cancel")[0]?.args).toEqual({ threadId: THREAD });
    await sending;
    await vi.waitFor(() => expect(app.watching()).toBe(0));
  });

  it("sends a message that follows a stop once the stopped run has ended", async () => {
    const stopped = runningThread([userMessage("Write a report", STOPPED_RUN)], STOPPED_RUN);
    const app = createApp({ ...stopped, activeRun: { ...stopped.activeRun!, stopping: true } });
    app.failSendWith("thread_busy", "The agent is still answering in this thread.");
    const { chat } = chatFor(app);
    const sending = chat.sendMessage("Never mind");
    await vi.waitFor(() => expect(app.callsTo("agent:send")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Refused, and waiting for the stop to land: not an error of the chat.
    expect(chat.getIsLoading()).toBe(true);
    expect(chat.getError()).toBeUndefined();
    expect(app.callsTo("agent:send")).toHaveLength(1);

    const reply = assistantMessage("msg_2", [{ type: "text", text: "All right." }]);
    app.push(
      frame(1, "run.started"),
      frame(2, "message.completed", { message: reply }),
      frame(3, "run.completed", { output: "All right.", usage: null }),
    );
    // The stopped run ends, and the thread takes messages again.
    app.acceptSends();
    app.setThread(
      settledThread([userMessage("Write a report", STOPPED_RUN)], {
        id: STOPPED_RUN,
        status: "cancelled",
        error: null,
        cappedReason: null,
        finished_at: null,
      }),
    );
    await vi.waitFor(() => expect(app.callsTo("agent:send")).toHaveLength(2));
    app.setThread(
      settledThread([userMessage("Write a report", STOPPED_RUN), userMessage("Never mind"), reply]),
    );
    await sending;
    expect(chat.getError()).toBeUndefined();
    expect(chat.getMessages().at(-1)?.parts).toEqual([{ type: "text", content: "All right." }]);
    expect(app.watching()).toBe(0);
  });

  it("reports thread_busy at once when no stop is why the thread is busy", async () => {
    // Another tab's run is going, and nobody stopped it.
    const app = createApp(runningThread([userMessage("Write a report", STOPPED_RUN)], STOPPED_RUN));
    app.failSendWith("thread_busy", "The agent is still answering in this thread.");
    const { chat } = chatFor(app);
    await chat.sendMessage("Never mind");
    expect(agentErrorCode(chat.getError())).toBe("thread_busy");
    expect(app.callsTo("agent:send")).toHaveLength(1);
    expect(app.watching()).toBe(0);
  });

  it("reports thread_busy when the stop does not land within the settle timeout", async () => {
    const stopped = runningThread([userMessage("Write a report", STOPPED_RUN)], STOPPED_RUN);
    const app = createApp({ ...stopped, activeRun: { ...stopped.activeRun!, stopping: true } });
    app.failSendWith("thread_busy", "The agent is still answering in this thread.");
    const { chat } = chatFor(app, { settleTimeoutMs: 30 });
    await chat.sendMessage("Never mind");
    expect(agentErrorCode(chat.getError())).toBe("thread_busy");
    expect(app.callsTo("agent:send")).toHaveLength(1);
    expect(app.watching()).toBe(0);
  });

  it("hydrates a thread for persistence, runs a page action left waiting, and joins the run going", async () => {
    const app = createApp({
      ...runningThread([
        userMessage("Open my order"),
        assistantMessage("msg_1", [{ type: "text", text: "Opening" }], "streaming"),
      ]),
      // Delivered while no tab was open, a moment ago.
      pageActions: [pendingPageAction("call_earlier", { orderId: "9" }, "run_earlier")],
    });
    const openOrder = vi.fn();
    const { chat, chunks } = chatFor(
      app,
      { pageActions: { open_order: openOrder } },
      { persistence: true },
    );
    app.push(...pageActionRun());
    chat.attach();

    await vi.waitFor(() => expect(app.fetchUrls).toHaveLength(1));
    // A join replays the run from its start.
    expect(app.fetchUrls[0]).toBe(LIVE_URL);
    expect(app.fetchHeaders[0]?.get("last-event-id")).toBeNull();
    await vi.waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(openOrder).toHaveBeenCalledWith(
      { orderId: "9" },
      { toolCallId: "call_earlier", runId: "run_earlier" },
    );
    // The run it joined sends one too, which runs when it is delivered.
    app.deliverPageAction(pendingPageAction("call_open", { orderId: "123" }));
    await vi.waitFor(() => expect(openOrder).toHaveBeenCalledTimes(2));

    deliverEnd(app);
    await vi.waitFor(() => expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED" }));
    await vi.waitFor(() => expect(chat.getIsLoading()).toBe(false));
    const messages = chat.getMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The replay rebuilt the reply in place of the partial one Convex had.
    expect(messages[1]?.parts[0]).toEqual({ type: "text", content: "Opening order 123." });
    expect(app.callsTo("agent:send")).toHaveLength(0);
    chat.dispose();
  });

  it("hydrates an unknown thread as empty, and refuses to join a run it has not read", async () => {
    const app = createApp(null);
    const connection = herculesConnection(app.client, api.agent, { fetch: app.fetch });
    expect(await connection.hydrate(THREAD)).toEqual({
      messages: [],
      activeRun: null,
      interrupts: null,
    });
    const joining = connection.joinRun("some-run")[Symbol.asyncIterator]().next();
    await expect(joining).rejects.toBeInstanceOf(AgentError);
  });

  it("passes TanStack's page size to the thread query", async () => {
    const app = createApp(settledThread([userMessage("Hi")]));
    const connection = herculesConnection(app.client, api.agent, { fetch: app.fetch });
    const result = await connection.hydrate(THREAD, { limit: 20 });
    expect(app.callsTo("agent:thread")[0]?.args).toEqual({ threadId: THREAD, limit: 20 });
    expect(result.messages).toHaveLength(1);
    expect(await connection.hydrate(THREAD, { limit: 20, before: "x" })).toMatchObject({
      messages: [],
    });
  });
});
