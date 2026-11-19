import { afterEach, describe, expect, it, vi } from "vitest";
import { followRun, parseEventStream, RunStreamError } from "../stream";
import { readAgentEvent, readWireEvent } from "../component/protocol";
import { CLIENT_ID } from "../component/protocol";
import { runStreamHeaders } from "../stream";
import packageJson from "../../package.json";

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

  it("reads a known event that carries fields it does not know, and passes them on", () => {
    const read = readAgentEvent({
      ...event(3, "message.delta", { message_id: "m", text: "Hi", logprobs: [0.1] }),
      trace_id: "t_1",
    });
    expect(read).toMatchObject({
      seq: 3,
      type: "message.delta",
      data: { message_id: "m", text: "Hi", logprobs: [0.1] },
    });
  });

  it("keeps a completed message's known parts, and reads new tool kinds and statuses", () => {
    const read = readAgentEvent(
      event(8, "message.completed", {
        message: {
          id: "m",
          thread_id: "thread_1",
          run_id: "run_1",
          role: "assistant",
          parts: [
            { type: "text", text: "Done." },
            { type: "reasoning", text: "Thinking." },
            { type: "tool_call", id: "c1", name: "search", kind: "connector", status: "succeeded" },
            { type: "tool_call", id: "c2", name: "refund", kind: "app", status: "denied" },
            { type: "tool_call", name: "no id", kind: "app", status: "succeeded" },
            "not a part",
          ],
          created_at: "2026-11-15T12:00:00.000Z",
        },
      }),
    );
    if (read?.type !== "message.completed") throw new Error("not read as message.completed");
    expect(read.data.message.parts).toEqual([
      { type: "text", text: "Done." },
      {
        type: "tool_call",
        id: "c1",
        name: "search",
        kind: "hercules",
        status: "succeeded",
        summary: null,
      },
      { type: "tool_call", id: "c2", name: "refund", kind: "app", status: "failed", summary: null },
    ]);
  });

  it("reads a tool call of a kind or with a status it does not know", () => {
    expect(
      readAgentEvent(event(4, "tool_call.started", { tool_call_id: "c", name: "n", kind: "mcp" })),
    ).toMatchObject({ data: { tool_call_id: "c", name: "n", kind: "hercules" } });
    expect(
      readAgentEvent(
        event(5, "tool_call.completed", {
          tool_call_id: "c",
          name: "n",
          kind: "app",
          status: "timed_out",
          summary: "Timed out",
          result: { partial: true },
        }),
      ),
    ).toMatchObject({
      data: { kind: "app", status: "failed", summary: "Timed out", result: { partial: true } },
    });
  });

  it("reads a run's ending whose reason or error it does not know", () => {
    expect(
      readAgentEvent(event(9, "run.capped", { capped_reason: "tool_calls", output: "So far." })),
    ).toMatchObject({ data: { capped_reason: null, output: "So far.", usage: null } });
    expect(
      readAgentEvent(event(9, "run.failed", { error: { code: "model_overloaded" } })),
    ).toMatchObject({ data: { error: { code: "model_overloaded", message: "model_overloaded" } } });
    // A failed run always has an error to show, whatever the event carried.
    expect(readAgentEvent(event(9, "run.failed", { error: "boom" }))).toMatchObject({
      data: { error: { code: "run_failed", message: "The run failed." }, usage: null },
    });
  });

  it("does not pass on an event of a type it does not know, marked final or not", () => {
    expect(readAgentEvent(event(4, "run.requires_action", { action: {} }))).toBeNull();
    expect(readAgentEvent({ ...event(9, "run.expired"), final: true })).toBeNull();
    expect(readWireEvent({ ...event(9, "run.expired"), final: true })).toMatchObject({
      seq: 9,
      data: { kind: "final", status: "failed", error: { code: "run_failed" } },
    });
    // The mark changes nothing about an event this version knows.
    expect(
      readWireEvent({ ...event(4, "run.progress", { label: "x" }), final: true }),
    ).toMatchObject({ data: { kind: "progress", label: "x" } });
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

  it("names the package on the stream request, and sends only headers the events route lets a page send", async () => {
    const { requests, fetch: fetchFn } = scripted([
      () => new Response(streamOf(sse(event(1, "run.started")))),
      () => new Response(streamOf(sse(event(2, "run.completed", { output: "" })))),
    ]);
    await collect(
      followRun({ url: URL_, token: "t", fetch: fetchFn, retry: { initialMs: 1, maxMs: 2 } }),
    );
    // The headers Hercules's events route lets a page send. One outside this
    // list fails the browser's preflight, and the live view with it.
    const allowed = [
      "authorization",
      "accept",
      "last-event-id",
      "hercules-version",
      "hercules-client",
    ];
    for (const request of requests) {
      expect([...request.headers.keys()].filter((name) => !allowed.includes(name))).toEqual([]);
      // The page names the package and its version, as the app's backend does.
      expect(request.headers.get("hercules-client")).toBe(CLIENT_ID);
    }
    expect(CLIENT_ID).toBe(`agents/${packageJson.version}`);
    expect(runStreamHeaders("t", 0)).toEqual({
      authorization: "Bearer t",
      accept: "text/event-stream",
      "hercules-version": "2025-12-09",
      "hercules-client": CLIENT_ID,
    });
    expect(runStreamHeaders("t", 4)).toEqual({
      authorization: "Bearer t",
      accept: "text/event-stream",
      "hercules-version": "2025-12-09",
      "hercules-client": CLIENT_ID,
      "last-event-id": "4",
    });
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

  it.each([[500], [503], [520], [599], [429], [408]])(
    "connects again after a %i, whatever its code",
    async (status) => {
      const { requests, fetch: fetchFn } = scripted([
        () => Response.json({ code: "a_code_added_later" }, { status }),
        () => new Response(streamOf(sse(event(1, "run.completed", { output: "" })))),
      ]);
      const events = await collect(
        followRun({ url: URL_, token: "t", fetch: fetchFn, retry: { initialMs: 1, maxMs: 2 } }),
      );
      expect(events.map((e) => e.seq)).toEqual([1]);
      expect(requests).toHaveLength(2);
    },
  );

  it.each([[400], [401], [403], [404], [410], [422]])(
    "gives up at once on a %i, with the code Hercules sent, known or not",
    async (status) => {
      const { requests, fetch: fetchFn } = scripted([
        () => Response.json({ code: "a_code_added_later" }, { status }),
      ]);
      const error = await collect(followRun({ url: URL_, token: "t", fetch: fetchFn })).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RunStreamError);
      expect(error).toMatchObject({ status, code: "a_code_added_later" });
      expect(requests).toHaveLength(1);
    },
  );

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

  const reply = (seq: number) =>
    event(seq, "message.completed", {
      message: {
        id: "m",
        thread_id: "thread_1",
        run_id: "run_1",
        role: "assistant",
        parts: [{ type: "text", text: "Done." }],
        created_at: "2026-11-15T12:00:00.000Z",
      },
    });

  it("skips events of types it does not know, and resumes after them", async () => {
    const { requests, fetch: fetchFn } = scripted([
      () =>
        new Response(
          streamOf(
            sse(event(1, "run.started")),
            sse(event(2, "reasoning.delta", { text: "Hm." })),
            sse(event(3, "message.delta", { message_id: "m", text: "Done." })),
            sse(event(4, "run.requires_action", { action: { type: "approval" } })),
          ),
        ),
      () =>
        new Response(streamOf(sse(reply(6)), sse(event(7, "run.completed", { output: "Done." })))),
    ]);
    const events = await collect(
      followRun({ url: URL_, token: "t", fetch: fetchFn, retry: { initialMs: 1, maxMs: 2 } }),
    );
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "run.started"],
      [3, "message.delta"],
      [6, "message.completed"],
      [7, "run.completed"],
    ]);
    // After the last event it was sent, though that one is not one it knows.
    expect(requests[1]?.headers.get("last-event-id")).toBe("4");
  });

  it("ends on an ending of a type it does not know that Hercules marks as final", async () => {
    const { requests, fetch: fetchFn } = scripted([
      () =>
        new Response(
          streamOf(
            sse(event(1, "run.started")),
            sse(reply(8)),
            sse({ ...event(9, "run.expired", { output: "Done." }), final: true }),
            sse(event(10, "message.delta", { message_id: "m", text: "never read" })),
          ),
        ),
    ]);
    const events = await collect(followRun({ url: URL_, token: "t", fetch: fetchFn }));
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "run.started"],
      [8, "message.completed"],
    ]);
    expect(requests).toHaveLength(1);
  });

  it("stops asking for a run whose ending it cannot read, and passes its reply on once", async () => {
    // Hercules answers a reader at the end of a finished run with the reply
    // and the final event again, and closes. The final event is of a type
    // added later, and is not marked.
    const ending = () =>
      new Response(streamOf(sse(reply(8)), sse(event(9, "run.expired", { output: "Done." }))));
    const { requests, fetch: fetchFn } = scripted([
      () =>
        new Response(
          streamOf(sse(event(1, "run.started")), sse(reply(8)), sse(event(9, "run.expired"))),
        ),
      ...Array.from({ length: 5 }, () => ending),
    ]);
    const seen: string[] = [];
    const error = await (async () => {
      for await (const e of followRun({
        url: URL_,
        token: "t",
        fetch: fetchFn,
        retry: { initialMs: 1, maxMs: 2, maxAttempts: 4 },
      })) {
        seen.push(`${e.seq} ${e.type}`);
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["1 run.started", "8 message.completed"]);
    // A bounded number of tries, then the live view gives up: the run's
    // ending reaches the page through the thread.
    expect(error).toBeInstanceOf(RunStreamError);
    expect(requests).toHaveLength(5);
  });

  describe("a run that is quiet for a long time", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is followed for as long as it takes: a stream Hercules closes after minutes is not a failure", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.UTC(2026, 10, 15, 12, 0, 0);
      vi.setSystemTime(start);
      let opened = 0;
      const encoder = new TextEncoder();
      const fetchFn = (async () => {
        const nth = ++opened;
        // Each stream stays open ten minutes with only a keep-alive and an
        // event of a type added later, as for a run that waits for a person.
        // The twelfth brings the run's ending.
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                vi.setSystemTime(start + nth * 10 * 60 * 1000);
                const frames =
                  nth < 12
                    ? [": keep-alive\n\n", sse(event(2, "run.requires_action"))]
                    : [sse(event(3, "run.completed", { output: "Done." }))];
                for (const text of frames) controller.enqueue(encoder.encode(text));
                controller.close();
              },
            },
            // Nothing is written until the stream is read.
            { highWaterMark: 0 },
          ),
        );
      }) as unknown as typeof fetch;
      const events = await collect(
        followRun({
          url: URL_,
          token: "t",
          fetch: fetchFn,
          retry: { initialMs: 1, maxMs: 2, maxAttempts: 3 },
        }),
      );
      expect(events.map((e) => e.seq)).toEqual([3]);
      expect(opened).toBe(12);
    });
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

  it("gives up at once when Hercules no longer takes this version of the package", async () => {
    const { requests, fetch: fetchFn } = scripted([
      () => Response.json({ code: "client_upgrade_required" }, { status: 426 }),
    ]);
    const error = await collect(followRun({ url: URL_, token: "t", fetch: fetchFn })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunStreamError);
    expect(error).toMatchObject({ status: 426, code: "client_upgrade_required" });
    expect(requests).toHaveLength(1);
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
