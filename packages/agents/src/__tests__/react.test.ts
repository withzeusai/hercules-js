// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentThread } from "../agents";
import { RunStreamError, useAgentThread, type UseAgentThreadOptions } from "../react";

const RUN = "run_1";
const THREAD = "thread_1";

function frame(seq: number, type: string, data: unknown = {}): string {
  const event = {
    id: `${RUN}:${seq}`,
    seq,
    run_id: RUN,
    thread_id: THREAD,
    type,
    created_at: "2026-11-15T12:00:00.000Z",
    data,
  };
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A live stream the test writes to, one frame at a time. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    fetch: vi.fn(async () => new Response(body)) as unknown as typeof fetch,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      controller.close();
    },
  };
}

function runningThread(overrides: Partial<AgentThread> = {}): AgentThread {
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
        parts: [{ type: "text", text: "Open my order" }],
        created_at: "2026-11-15T12:00:00.000Z",
        status: "completed",
      },
    ],
    activeRun: {
      id: RUN,
      status: "running",
      progress: null,
      live: { url: "https://api.hercules.test/v1/agents/runs/run_1/events", token: "run-token" },
      lastSeq: 0,
      created_at: "2026-11-15T12:00:00.000Z",
      stopping: false,
    },
    latestRun: { id: RUN, status: "running", error: null, cappedReason: null, finished_at: null },
    pageActions: [],
    ...overrides,
  };
}

describe("useAgentThread", () => {
  function pageAction(
    toolCallId: string,
    status: "pending" | "expired" = "pending",
    args: unknown = {},
  ): AgentThread["pageActions"][number] {
    return {
      toolCallId,
      runId: RUN,
      name: "open_order",
      argumentsJson: JSON.stringify(args),
      // The browser's clock plays no part: this one is long past, and still pending.
      created_at: "2026-11-15T12:00:00.000Z",
      status,
    };
  }

  it("streams the reply, runs a claimed page action once, and settles on Convex's copy", async () => {
    const stream = liveStream();
    const openOrder = vi.fn();
    const claimPageAction = vi.fn(async () => true);
    const options: UseAgentThreadOptions = {
      threadId: THREAD,
      thread: runningThread(),
      send: vi.fn(),
      claimPageAction,
      pageActions: { open_order: openOrder },
      fetch: stream.fetch,
    };
    const { result, rerender } = renderHook(
      (props: UseAgentThreadOptions) => useAgentThread(props),
      {
        initialProps: options,
      },
    );
    expect(result.current.status).toBe("submitted");

    await act(async () => {
      stream.push(frame(1, "run.started"));
      stream.push(frame(2, "message.delta", { message_id: "msg_1", text: "Opening " }));
      stream.push(frame(3, "message.delta", { message_id: "msg_1", text: "it now" }));
      stream.push(
        frame(4, "page_action", {
          tool_call_id: "call_1",
          name: "open_order",
          arguments: { orderId: "123" },
        }),
      );
    });
    await waitFor(() =>
      expect(result.current.messages[1]?.parts[0]).toEqual({
        type: "text",
        text: "Opening it now",
      }),
    );
    expect(result.current.status).toBe("streaming");
    // The live stream shows the page action in the chat. It runs once Hercules
    // has delivered it to the app, which is when it can be claimed.
    expect(result.current.messages[1]?.parts[1]).toMatchObject({
      type: "tool_call",
      id: "call_1",
      kind: "page",
      status: "sent",
    });
    expect(claimPageAction).not.toHaveBeenCalled();

    const delivered = runningThread({
      pageActions: [pageAction("call_1", "pending", { orderId: "123" })],
    });
    rerender({ ...options, thread: delivered });
    await waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(openOrder).toHaveBeenCalledWith(
      { orderId: "123" },
      { toolCallId: "call_1", runId: RUN },
    );
    expect(claimPageAction).toHaveBeenCalledWith({
      threadId: THREAD,
      runId: RUN,
      toolCallId: "call_1",
    });

    // The thread is read again with the action still listed: this tab already took it.
    rerender({ ...options, thread: { ...delivered } });
    expect(claimPageAction).toHaveBeenCalledTimes(1);

    // The run is over in Convex.
    rerender({
      ...options,
      thread: runningThread({
        activeRun: null,
        latestRun: {
          id: RUN,
          status: "completed",
          error: null,
          cappedReason: null,
          finished_at: null,
        },
        messages: [
          ...runningThread().messages,
          {
            id: "msg_1",
            thread_id: THREAD,
            run_id: RUN,
            role: "assistant",
            parts: [{ type: "text", text: "Opening it now." }],
            created_at: "2026-11-15T12:00:01.000Z",
            status: "completed",
          },
        ],
      }),
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.messages.map((m) => m.parts)).toEqual([
      [{ type: "text", text: "Open my order" }],
      [{ type: "text", text: "Opening it now." }],
    ]);
    stream.close();
  });

  it("leaves an expired page action to the page to report, and runs the pending one", async () => {
    const openOrder = vi.fn();
    const claimPageAction = vi.fn(async (_args: { toolCallId: string }) => true);
    const thread = runningThread({
      activeRun: null,
      // One that reached the app too late, and one in time.
      pageActions: [pageAction("call_late", "expired"), pageAction("call_new")],
    });
    renderHook(() =>
      useAgentThread({
        thread,
        send: vi.fn(),
        claimPageAction,
        pageActions: { open_order: openOrder },
      }),
    );
    await waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(claimPageAction.mock.calls.map(([args]) => args.toolCallId)).toEqual(["call_new"]);
    // The app reads the one that was not run off the thread, to tell the user.
    expect(thread.pageActions.filter((action) => action.status === "expired")).toHaveLength(1);
  });

  it("does not run a page action whose claim the server refused as too old", async () => {
    const openOrder = vi.fn();
    // The thread was read while it was pending; by the server's clock it no longer is.
    const claimPageAction = vi.fn(async () => false);
    const options = {
      thread: runningThread({ activeRun: null, pageActions: [pageAction("call_1")] }),
      send: vi.fn(),
      claimPageAction,
      pageActions: { open_order: openOrder },
    };
    const { rerender } = renderHook((props: UseAgentThreadOptions) => useAgentThread(props), {
      initialProps: options,
    });
    await waitFor(() => expect(claimPageAction).toHaveBeenCalledTimes(1));
    // The refusal marked it, and the thread reads again with it expired.
    rerender({
      ...options,
      thread: runningThread({ activeRun: null, pageActions: [pageAction("call_1", "expired")] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claimPageAction).toHaveBeenCalledTimes(1);
    expect(openOrder).not.toHaveBeenCalled();
  });

  it("does not run a page action another tab claimed, and tries again after a failed claim", async () => {
    const openOrder = vi.fn();
    const answers: Array<boolean | Error> = [new Error("offline"), false];
    const claimPageAction = vi.fn(async () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? true;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const thread = runningThread({
      activeRun: null,
      pageActions: [pageAction("call_1")],
    });
    const options = {
      thread,
      send: vi.fn(),
      claimPageAction,
      pageActions: { open_order: openOrder },
    };
    const { rerender } = renderHook((props: UseAgentThreadOptions) => useAgentThread(props), {
      initialProps: options,
    });
    await waitFor(() => expect(claimPageAction).toHaveBeenCalledTimes(1));
    // The claim could not be made: the next read of the thread tries again.
    rerender({ ...options, thread: { ...thread } });
    await waitFor(() => expect(claimPageAction).toHaveBeenCalledTimes(2));
    // Another tab had it: this one never runs it, and does not ask again.
    rerender({ ...options, thread: { ...thread } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claimPageAction).toHaveBeenCalledTimes(2);
    expect(openOrder).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reports a live view that failed while the run goes on, and drops it when the reply is there", async () => {
    // Hercules refuses the run's live stream for good.
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ code: "invalid_run_token" }), { status: 401 }),
    ) as unknown as typeof fetch;
    const options: UseAgentThreadOptions = {
      threadId: THREAD,
      thread: runningThread(),
      send: vi.fn(),
      fetch: fetchFn,
    };
    const { result, rerender } = renderHook(
      (props: UseAgentThreadOptions) => useAgentThread(props),
      { initialProps: options },
    );
    await waitFor(() => expect(result.current.error).toBeInstanceOf(RunStreamError));
    expect(result.current.error).toMatchObject({ status: 401, code: "invalid_run_token" });
    // It is the live view that failed. The run is still going.
    expect(result.current.status).toBe("submitted");

    // Convex has the reply and the run's end: nothing is wrong any more.
    rerender({
      ...options,
      thread: runningThread({
        activeRun: null,
        latestRun: {
          id: RUN,
          status: "completed",
          error: null,
          cappedReason: null,
          finished_at: "2026-11-15T12:00:05.000Z",
        },
        messages: [
          ...runningThread().messages,
          {
            id: "msg_1",
            thread_id: THREAD,
            run_id: RUN,
            role: "assistant",
            parts: [{ type: "text", text: "Here it is." }],
            created_at: "2026-11-15T12:00:01.000Z",
            status: "completed",
          },
        ],
      }),
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("ready");
    expect(result.current.messages.at(-1)?.parts).toEqual([{ type: "text", text: "Here it is." }]);
  });

  it("does not bring one run's stream failure back with the next run", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ code: "invalid_run_token" }), { status: 401 }),
    ) as unknown as typeof fetch;
    const options: UseAgentThreadOptions = {
      threadId: THREAD,
      thread: runningThread(),
      send: vi.fn(),
      fetch: fetchFn,
    };
    const { result, rerender } = renderHook(
      (props: UseAgentThreadOptions) => useAgentThread(props),
      { initialProps: options },
    );
    await waitFor(() => expect(result.current.error).toBeInstanceOf(RunStreamError));

    // That run ends, and the user sends again. The new run is queued:
    // Hercules has not answered with its live stream yet.
    const next = runningThread();
    rerender({ ...options, thread: { ...next, activeRun: null } });
    expect(result.current.error).toBeNull();
    rerender({
      ...options,
      thread: {
        ...next,
        activeRun: { ...next.activeRun!, id: "run_2", status: "queued", live: null },
        latestRun: {
          id: "run_2",
          status: "queued",
          error: null,
          cappedReason: null,
          finished_at: null,
        },
      },
    });
    // Nothing has failed for this run. The old error stayed, since nothing cleared it.
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("submitted");
  });

  it("shows the message as pending while it is sent, and reports why it was not", async () => {
    let reject!: (error: unknown) => void;
    const send = vi.fn(
      () =>
        new Promise<{ threadId: string; runId: string }>((_, r) => {
          reject = r;
        }),
    );
    const { result } = renderHook(() =>
      useAgentThread({ threadId: null, thread: undefined, send }),
    );
    expect(result.current.status).toBe("ready");
    let sent!: Promise<unknown>;
    act(() => {
      sent = result.current.send("Hello");
    });
    expect(result.current.status).toBe("submitted");
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "user",
        status: "pending",
        parts: [{ type: "text", text: "Hello" }],
      }),
    ]);
    expect(send).toHaveBeenCalledWith({ text: "Hello" });
    await act(async () => {
      reject(
        Object.assign(new Error("ConvexError"), {
          data: { code: "end_user_rate_limited", message: "Slow down.", retryAfterSeconds: 90 },
        }),
      );
      await sent;
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toMatchObject({
      name: "AgentError",
      code: "end_user_rate_limited",
      message: "Slow down.",
      retryAfterSeconds: 90,
    });
  });

  it("reports a failed run", () => {
    const { result } = renderHook(() =>
      useAgentThread({
        thread: runningThread({
          activeRun: null,
          latestRun: {
            id: RUN,
            status: "failed",
            error: { code: "out_of_credits", message: "Out of credits." },
            cappedReason: null,
            finished_at: "2026-11-15T12:00:05.000Z",
          },
        }),
        send: vi.fn(),
      }),
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toMatchObject({ code: "out_of_credits" });
  });

  it("says how long a limit that failed the run lasts", () => {
    const { result } = renderHook(() =>
      useAgentThread({
        thread: runningThread({
          activeRun: null,
          latestRun: {
            id: RUN,
            status: "failed",
            error: {
              code: "agent_daily_limit_reached",
              message: "The agent's daily credit limit is reached.",
              retryAfterSeconds: 20_000,
            },
            cappedReason: null,
            finished_at: "2026-11-15T12:00:05.000Z",
          },
        }),
        send: vi.fn(),
      }),
    );
    expect(result.current.error).toMatchObject({
      code: "agent_daily_limit_reached",
      retryAfterSeconds: 20_000,
    });
  });
});
