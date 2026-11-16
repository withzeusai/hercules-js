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
    agentId: "agt_1",
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
    latestRun: { id: RUN, status: "running", error: null, cappedReason: null },
    pageActions: [],
    ...overrides,
  };
}

describe("useAgentThread", () => {
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

    // Convex now lists the same page action as pending: this tab already took it.
    rerender({
      ...options,
      thread: runningThread({
        pageActions: [
          {
            toolCallId: "call_1",
            runId: RUN,
            name: "open_order",
            argumentsJson: "{}",
            created_at: "",
          },
        ],
      }),
    });
    expect(claimPageAction).toHaveBeenCalledTimes(1);

    // The run is over in Convex.
    rerender({
      ...options,
      thread: runningThread({
        activeRun: null,
        latestRun: { id: RUN, status: "completed", error: null, cappedReason: null },
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
          data: { code: "thread_busy", message: "Busy." },
        }),
      );
      await sent;
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toMatchObject({
      name: "AgentError",
      code: "thread_busy",
      message: "Busy.",
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
          },
        }),
        send: vi.fn(),
      }),
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toMatchObject({ code: "out_of_credits" });
  });
});
