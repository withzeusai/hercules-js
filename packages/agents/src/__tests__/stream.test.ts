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

  /** A fetch that answers from a list, and records what was asked. */
  function scripted(responses: Array<() => Response>) {
    const requests: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      return next();
    }) as typeof fetch;
    return { requests, fetch: fetchFn };
  }
  const URL_ = "https://api.hercules.test/v1/agents/runs/run_1/events";
  const tooMany = () =>
    new Response(JSON.stringify({ code: "rate_limited" }), {
      status: 429,
      headers: { "retry-after": "0.01" },
    });

  it("passes on a run's ending numbered at or below an event it already read", async () => {
    // Hercules ended the run itself (its reaper, or a cancel of a run nothing
    // was running), and numbered the ending after what it had stored, which
    // is below what the stream had already sent.
    const { fetch: fetchFn } = scripted([
      () =>
        new Response(
          streamOf(
            sse(event(1, "run.started")),
            sse(event(7, "message.delta", { message_id: "m", text: "Hel" })),
            sse(
              event(4, "message.completed", {
                message: {
                  id: "m",
                  thread_id: "thread_1",
                  run_id: "run_1",
                  role: "assistant",
                  parts: [{ type: "text", text: "Hel" }],
                  created_at: "2026-11-15T12:00:00.000Z",
                },
              }),
            ),
            // An ordinary event below the cursor is still a repeat.
            sse(event(3, "message.delta", { message_id: "m", text: "repeat" })),
            sse(event(5, "run.failed", { error: { code: "run_failed", message: "Ended." } })),
          ),
        ),
    ]);
    const events = await collect(followRun({ url: URL_, token: "t", fetch: fetchFn }));
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "run.started"],
      [7, "message.delta"],
      [4, "message.completed"],
      [5, "run.failed"],
    ]);
  });

  it("waits as told on 429 and goes on once a stream is free", async () => {
    // Ten streams of the run are open already. One closes.
    const { requests, fetch: fetchFn } = scripted([
      tooMany,
      tooMany,
      () =>
        new Response(
          streamOf(sse(event(1, "run.started")), sse(event(2, "run.completed", { output: "" }))),
        ),
    ]);
    const events = await collect(
      followRun({ url: URL_, token: "t", fetch: fetchFn, retry: { initialMs: 1, maxMs: 2 } }),
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(requests).toHaveLength(3);
  });

  it("says it was the stream cap when it never gets a stream", async () => {
    const { requests, fetch: fetchFn } = scripted(Array.from({ length: 3 }, () => tooMany));
    const error = await collect(
      followRun({
        url: URL_,
        token: "t",
        fetch: fetchFn,
        retry: { initialMs: 1, maxMs: 2, maxAttempts: 3 },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunStreamError);
    // The live view failed, not the run: the page can tell by the status.
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    expect(requests).toHaveLength(3);
  });

  it("picks the run up again when Hercules closes a stream that has been open ten minutes", async () => {
    const { requests, fetch: fetchFn } = scripted([
      // Closed by Hercules with the run still going.
      () =>
        new Response(
          streamOf(
            sse(event(1, "run.started")),
            sse(event(2, "message.delta", { message_id: "m", text: "Still " })),
          ),
        ),
      () =>
        new Response(
          streamOf(
            sse(event(3, "message.delta", { message_id: "m", text: "going" })),
            sse(event(4, "run.completed", { output: "Still going" })),
          ),
        ),
    ]);
    const events = await collect(
      followRun({ url: URL_, token: "t", fetch: fetchFn, retry: { initialMs: 1, maxMs: 2 } }),
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(requests[1]?.headers.get("last-event-id")).toBe("2");
    expect(requests[1]?.url).toContain("after=2");
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
