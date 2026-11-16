import { describe, expect, it } from "vitest";
import { followRun, parseEventStream, RunStreamError } from "../stream";
import { readAgentEvent, readWireEvent } from "../component/protocol";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(event: Record<string, unknown>): string {
  return `id: ${String(event["seq"])}\nevent: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`;
}

function event(seq: number, type: string, data: unknown = {}) {
  return {
    id: `run_1:${seq}`,
    seq,
    run_id: "run_1",
    thread_id: "thread_1",
    type,
    created_at: "2026-11-15T12:00:00.000Z",
    data,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("parseEventStream", () => {
  it("reads events split across chunks, with CRLF, comments and multi-line data", async () => {
    const events = await collect(
      parseEventStream(
        streamOf(
          ": keep-alive\r\n",
          "id: 1\r\nevent: a\r",
          "\ndata: one\r\ndata: two\r\n\r\n",
          "id: 2\ndata: three\n\n",
        ),
      ),
    );
    expect(events).toEqual([
      { id: "1", event: "a", data: "one\ntwo" },
      { id: "2", event: null, data: "three" },
    ]);
  });
});

describe("readAgentEvent", () => {
  it("keeps known events and drops what it cannot read", () => {
    expect(
      readAgentEvent(event(3, "message.delta", { message_id: "m", text: "Hi" })),
    ).toMatchObject({
      seq: 3,
      type: "message.delta",
      data: { message_id: "m", text: "Hi" },
    });
    expect(readAgentEvent(event(3, "message.delta", { text: "no id" }))).toBeNull();
    expect(readAgentEvent(event(4, "brand.new"))).toBeNull();
    expect(readAgentEvent({ ...event(0, "run.started") })).toBeNull();
  });

  it("keeps an unknown type's place in the sequence when delivered", () => {
    expect(readWireEvent(event(4, "brand.new", { anything: true }))).toMatchObject({
      seq: 4,
      data: { kind: "none" },
    });
  });
});

describe("followRun", () => {
  it("reconnects after a drop with Last-Event-ID and stops at the run's last event", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const responses = [
      () =>
        new Response(
          streamOf(
            sse(event(1, "run.started")),
            sse(event(2, "message.delta", { message_id: "m", text: "He" })),
          ),
        ),
      () => {
        throw new TypeError("network down");
      },
      () =>
        new Response(
          streamOf(
            // A replayed event is not yielded twice.
            sse(event(2, "message.delta", { message_id: "m", text: "He" })),
            sse(event(3, "message.delta", { message_id: "m", text: "llo" })),
            sse(event(4, "run.completed", { output: "Hello", usage: null })),
            sse(event(5, "message.delta", { message_id: "m", text: "never read" })),
          ),
        ),
    ];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      return next();
    }) as typeof fetch;

    const events = await collect(
      followRun({
        url: "https://api.hercules.test/v1/agents/runs/run_1/events",
        token: "run-token",
        fetch: fetchFn,
        retry: { initialMs: 1, maxMs: 2 },
      }),
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer run-token");
    expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(requests[0]?.headers.get("hercules-version")).toBe("2025-12-09");
    expect(requests[0]?.headers.get("last-event-id")).toBeNull();
    expect(requests[2]?.headers.get("last-event-id")).toBe("2");
    expect(requests[2]?.url).toContain("after=2");
  });

  it("gives up at once when the token is refused", async () => {
    const fetchFn = (async () =>
      Response.json({ code: "invalid_run_token" }, { status: 401 })) as unknown as typeof fetch;
    const error = await collect(
      followRun({ url: "https://api.hercules.test/x", token: "bad", fetch: fetchFn }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunStreamError);
    expect(error).toMatchObject({ status: 401, code: "invalid_run_token" });
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const fetchFn = (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    expect(
      await collect(
        followRun({
          url: "https://api.hercules.test/x",
          token: "t",
          fetch: fetchFn,
          signal: controller.signal,
        }),
      ),
    ).toEqual([]);
  });
});
