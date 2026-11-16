import { toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai/client";
import { ChatClient } from "@tanstack/ai-client";
import { describe, expect, it, vi } from "vitest";
import { PAGE_ACTION_OUTPUT } from "../ag-ui";
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
