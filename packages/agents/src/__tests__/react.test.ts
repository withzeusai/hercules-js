// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentThread } from "../agents";
import { useAgentThread, type UseAgentThreadOptions } from "../react";

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
    },
    latestRun: { id: RUN, status: "running", error: null, cappedReason: null, finished_at: null },
    pageActions: [],
    ...overrides,
  };
}

describe("useAgentThread", () => {
  function pending(toolCallId: string, createdAt: string, args: unknown = {}) {
    return {
      toolCallId,
      runId: RUN,
      name: "open_order",
      argumentsJson: JSON.stringify(args),
      created_at: createdAt,
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
      pageActions: [pending("call_1", new Date().toISOString(), { orderId: "123" })],
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

  it("skips a page action that is two minutes old without claiming it", async () => {
    const openOrder = vi.fn();
    const claimPageAction = vi.fn(async (_args: { toolCallId: string }) => true);
    const old = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    renderHook(() =>
      useAgentThread({
        thread: runningThread({
          activeRun: null,
          // One delivered long after it was written, one with no time, and one in time.
          pageActions: [
            pending("call_old", old),
            pending("call_undated", ""),
            pending("call_new", new Date().toISOString()),
          ],
        }),
        send: vi.fn(),
        claimPageAction,
        pageActions: { open_order: openOrder },
      }),
    );
    await waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(claimPageAction.mock.calls.map(([args]) => args.toolCallId)).toEqual(["call_new"]);
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
      pageActions: [pending("call_1", new Date().toISOString())],
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
