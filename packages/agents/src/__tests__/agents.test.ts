import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerculesAgents, type AgentThread } from "../convex";
import { EVENTS_PATH } from "../component/protocol";
import {
  SEGMENT_MAX_BYTES,
  joinSegments,
  segmentParts,
  splitText,
  utf8Length,
} from "../component/store";
import { createTokenVerifier } from "../jwt";
import { createHarness, type Harness } from "./convex-harness";
import { createTestIssuer, ISSUER, NOW_MS, NOW_SECONDS } from "./helpers";

const API_URL = "https://api.hercules.test";
const AGENT_ID = "agt_01TEST";
const ALICE = "https://auth.app.test|alice";
const BOB = "https://auth.app.test|bob";

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: any;
}

/** A stand-in Hercules API: records every request and answers from `routes`. */
function createFakeHercules() {
  const requests: Recorded[] = [];
  let answer: (request: Recorded) => Response | undefined = () => undefined;

  function defaultAnswer(request: Recorded): Response {
    const runMatch = /^\/v1\/agents\/runs\/([^/]+)(\/cancel|\/events)?/.exec(request.path);
    if (request.method === "POST" && /^\/v1\/agents\/[^/]+\/runs$/.test(request.path)) {
      const runId = request.body.run_id as string;
      return Response.json(
        {
          run: { id: runId, thread_id: request.body.thread_id, status: "queued" },
          live: { url: `${API_URL}/v1/agents/runs/${runId}/events`, token: `token-${runId}` },
        },
        { status: 202 },
      );
    }
    if (runMatch !== null && runMatch[2] === "/cancel") {
      return Response.json({ id: runMatch[1], status: "cancelled", usage: { credits: 0.5 } });
    }
    if (runMatch !== null && runMatch[2] === "/events") {
      return Response.json({ data: [], has_more: false });
    }
    if (runMatch !== null) return Response.json({ id: runMatch[1], status: "running" });
    if (request.method === "DELETE") return Response.json({ id: "x", deleted: true });
    return new Response("not found", { status: 404 });
  }

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return answer(request) ?? defaultAnswer(request);
  }) as typeof fetch;

  return {
    requests,
    fetch: fetchFn,
    answerWith(next: (request: Recorded) => Response | undefined) {
      answer = next;
    },
  };
}

let h: Harness;
let api: ReturnType<typeof createFakeHercules>;
let finished: unknown[];

function agents(overrides: Partial<ConstructorParameters<typeof HerculesAgents>[1]> = {}) {
  return new HerculesAgents(h.component, {
    agentId: AGENT_ID,
    apiKey: "hercules-app-key",
    apiUrl: API_URL,
    onRunFinished: makeFunctionReference<"mutation">("orders:onAgentRunFinished") as never,
    ...overrides,
  });
}

function event(runId: string, threadId: string, seq: number, type: string, data: unknown = {}) {
  return {
    id: `${runId}:${seq}`,
    seq,
    run_id: runId,
    thread_id: threadId,
    type,
    created_at: "2026-11-15T12:00:00.000Z",
    data,
  };
}

/** Delivers events the way Hercules does, through the app's HTTP route. */
async function deliver(support: HerculesAgents, ...events: unknown[]) {
  const response = await support.handleEvents(
    h.appCtx(),
    new Request(`https://app.convex.site${EVENTS_PATH}`, {
      method: "POST",
      body: JSON.stringify({ events }),
    }),
    // The token is checked in its own tests below.
    {
      verify: async () => ({
        ok: true,
        token: { issuer: ISSUER, subject: "hercules", claims: { hercules_principal: "hercules" } },
      }),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { applied: number; skipped: number };
}

async function read(support: HerculesAgents, threadId: string, as = ALICE): Promise<AgentThread> {
  const thread = await support.readThread(h.appCtx(as), { threadId });
  expect(thread).not.toBeNull();
  return thread as AgentThread;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ConvexError ? (error.data as { code: string }).code : undefined;
}

beforeEach(() => {
  finished = [];
  h = createHarness({
    appFunctions: { "orders:onAgentRunFinished": (args) => finished.push(args) },
  });
  api = createFakeHercules();
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("send", () => {
  it("writes the user's message and the run, then starts it at Hercules", async () => {
    const support = agents({ pageActions: ["open_order"] });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), {
      text: "Where is my order?",
      context: { page: "/orders" },
    });
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    let thread = await read(support, threadId);
    expect(thread.messages).toEqual([
      expect.objectContaining({
        role: "user",
        run_id: runId,
        parts: [{ type: "text", text: "Where is my order?" }],
        status: "completed",
      }),
    ]);
    expect(thread.activeRun).toMatchObject({ id: runId, status: "queued", live: null, lastSeq: 0 });

    await h.runDue();
    const start = api.requests[0]!;
    expect(start.method).toBe("POST");
    expect(start.path).toBe(`/v1/agents/${AGENT_ID}/runs`);
    expect(start.headers.get("authorization")).toBe("Bearer hercules-app-key");
    expect(start.headers.get("hercules-version")).toBe("2025-12-09");
    expect(start.body).toEqual({
      run_id: runId,
      thread_id: threadId,
      end_user: { token_identifier: ALICE },
      input: [{ type: "text", text: "Where is my order?" }],
      context: { page: "/orders" },
      page_actions: ["open_order"],
    });

    thread = await read(support, threadId);
    expect(thread.activeRun?.live).toEqual({
      url: `${API_URL}/v1/agents/runs/${runId}/events`,
      token: `token-${runId}`,
    });
  });

  it("refuses a caller who is not signed in", async () => {
    const error = await agents()
      .send(h.appCtx(null), { text: "Hi", anonymousId: "visitor-1" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("sign_in_required");
    expect(h.db.all("runs")).toHaveLength(0);
  });

  it("takes a visitor by anonymous id when the agent allows it", async () => {
    const support = agents({ allowAnonymous: true });
    const { threadId } = await support.send(h.appCtx(null), {
      text: "Hi",
      anonymousId: "visitor-1",
    });
    await h.runDue();
    expect(api.requests[0]?.body.end_user).toEqual({ anonymous_id: "visitor-1" });
    expect(
      await support.readThread(h.appCtx(null), { threadId, anonymousId: "visitor-1" }),
    ).not.toBeNull();
    expect(
      await support.readThread(h.appCtx(null), { threadId, anonymousId: "visitor-2" }),
    ).toBeNull();
  });

  it("answers only to the thread's owner", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    expect(await support.readThread(h.appCtx(BOB), { threadId })).toBeNull();
    const error = await support
      .send(h.appCtx(BOB), { threadId, text: "Me too" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("not_found");
  });

  it("allows one run at a time per thread", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "First" });
    const error = await support
      .send(h.appCtx(ALICE), { threadId, text: "Second" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("thread_busy");
  });

  it("limits runs per user per hour in the same transaction", async () => {
    const support = agents({ limits: { runsPerUserPerHour: 2 } });
    await support.send(h.appCtx(ALICE), { text: "One" });
    await support.send(h.appCtx(ALICE), { text: "Two" });
    const error = await support.send(h.appCtx(ALICE), { text: "Three" }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe("end_user_rate_limited");
    const { retryAfterSeconds } = (error as ConvexError<{ retryAfterSeconds: number }>).data;
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(3600);
    expect(retryAfterSeconds).toBeLessThanOrEqual(3601);
    // Someone else is not held back, and the hour passes.
    await support.send(h.appCtx(BOB), { text: "One" });
    h.advance(60 * 60 * 1000 + 1);
    await support.send(h.appCtx(ALICE), { text: "Three" });
  });

  it("refuses input over the size limit before writing anything", async () => {
    const error = await agents()
      .send(h.appCtx(ALICE), { text: "x".repeat(262_145) })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("message_too_long");
    expect(h.db.all("threads")).toHaveLength(0);
  });

  it("starts the app's own runs with no end user", async () => {
    const support = agents({ limits: { runsPerUserPerHour: 0 } });
    const { threadId } = await support.run(h.appCtx(), { text: "Summarize today's orders" });
    await h.runDue();
    expect(api.requests[0]?.body.end_user).toBeUndefined();
    // No user can read the app's thread.
    expect(await support.readThread(h.appCtx(ALICE), { threadId })).toBeNull();
  });
});

describe("starting a run", () => {
  it("retries what may pass with the same body, then gives up", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith(() => (++calls <= 2 ? new Response("busy", { status: 503 }) : undefined));
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    const starts = api.requests.filter((r) => r.method === "POST");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
  });

  it("fails the run with Hercules's code when it refuses it", async () => {
    const support = agents();
    api.answerWith((request) =>
      request.method === "POST"
        ? Response.json(
            { code: "agent_disabled", title: "Conflict", detail: "The agent is turned off." },
            { status: 409 },
          )
        : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toEqual({
      id: runId,
      status: "failed",
      error: { code: "agent_disabled", message: "The agent is turned off." },
      cappedReason: null,
    });
    await h.runDue();
    expect(finished).toEqual([expect.objectContaining({ runId, status: "failed" })]);
  });
});

describe("delivered events", () => {
  it("streams a reply, completes it, ends the run and calls onRunFinished", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();

    await deliver(
      support,
      event(runId, threadId, 1, "run.queued"),
      event(runId, threadId, 2, "run.started"),
      event(runId, threadId, 4, "message.appended", { message_id: "msg_1", text: "Hello" }),
      event(runId, threadId, 7, "message.appended", { message_id: "msg_1", text: ", Alice" }),
    );
    let thread = await read(support, threadId);
    expect(thread.activeRun).toMatchObject({ status: "running", lastSeq: 7 });
    expect(thread.messages[1]).toMatchObject({
      id: "msg_1",
      role: "assistant",
      status: "streaming",
      parts: [{ type: "text", text: "Hello, Alice" }],
    });

    const message = {
      id: "msg_1",
      thread_id: threadId,
      run_id: runId,
      role: "assistant",
      parts: [
        { type: "text", text: "Hello, Alice. Your order shipped." },
        {
          type: "tool_call",
          id: "call_1",
          name: "lookup_order",
          kind: "app",
          status: "succeeded",
          summary: "Looked up order 123",
          // Fields the package does not know are dropped.
          extra: { $ref: "#/x" },
        },
      ],
      created_at: "2026-11-15T12:00:01.000Z",
    };
    await deliver(
      support,
      event(runId, threadId, 9, "tool_call.completed", {
        tool_call_id: "call_1",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
        result: { $schema: "kept as JSON text", order: 123 },
      }),
      event(runId, threadId, 10, "message.completed", { message }),
      event(runId, threadId, 11, "run.completed", {
        output: "Hello, Alice. Your order shipped.",
        usage: { credits: 1.25 },
      }),
    );

    thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({ id: runId, status: "completed" });
    expect(thread.messages.map((m) => [m.id, m.status])).toEqual([
      [`${runId}:input`, "completed"],
      ["msg_1", "completed"],
    ]);
    expect(thread.messages[1]?.parts[1]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "lookup_order",
      kind: "app",
      status: "succeeded",
      summary: "Looked up order 123",
    });
    expect(h.db.all("message_chunks")).toHaveLength(0);
    expect(h.db.all("tool_calls")[0]?.["resultJson"]).toBe(
      JSON.stringify({ $schema: "kept as JSON text", order: 123 }),
    );

    await h.runDue();
    expect(finished).toEqual([
      {
        runId,
        threadId,
        agentId: AGENT_ID,
        status: "completed",
        output: "Hello, Alice. Your order shipped.",
        error: null,
        cappedReason: null,
        usage: { credits: 1.25 },
        endUser: { tokenIdentifier: ALICE },
      },
    ]);

    // The thread takes the next message.
    await support.send(h.appCtx(ALICE), { threadId, text: "Thanks" });
  });

  it("applies each (run_id, seq) once", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const batch = [
      event(runId, threadId, 3, "message.appended", { message_id: "msg_1", text: "Hel" }),
      event(runId, threadId, 5, "message.appended", { message_id: "msg_1", text: "lo" }),
    ];
    expect(await deliver(support, ...batch)).toEqual({ applied: 2, skipped: 0 });
    // A redelivery after an expired lease, and an older event out of order.
    expect(await deliver(support, ...batch)).toEqual({ applied: 0, skipped: 2 });
    expect(await deliver(support, batch[0])).toEqual({ applied: 0, skipped: 1 });
    expect((await read(support, threadId)).messages[1]?.parts).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });

  it("orders a batch by sequence number", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await deliver(
      support,
      event(runId, threadId, 6, "message.appended", { message_id: "msg_1", text: "lo" }),
      event(runId, threadId, 3, "message.appended", { message_id: "msg_1", text: "Hel" }),
    );
    expect((await read(support, threadId)).messages[1]?.parts).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });

  it("replaces its copy of the user's message with Hercules's", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await deliver(
      support,
      event(runId, threadId, 2, "message.completed", {
        message: {
          id: "msg_user",
          thread_id: threadId,
          run_id: runId,
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
          created_at: "2026-11-15T12:00:00.000Z",
        },
      }),
    );
    const thread = await read(support, threadId);
    expect(thread.messages.map((m) => m.id)).toEqual(["msg_user"]);
  });

  it("keeps a reply cut off by a failed run as incomplete", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await deliver(
      support,
      event(runId, threadId, 3, "message.appended", { message_id: "msg_1", text: "Let me" }),
      event(runId, threadId, 4, "run.failed", {
        error: { code: "out_of_credits", message: "The organization is out of credits." },
        usage: { credits: 0.1 },
      }),
    );
    const thread = await read(support, threadId);
    expect(thread.messages[1]).toMatchObject({
      status: "incomplete",
      parts: [{ type: "text", text: "Let me" }],
    });
    expect(thread.latestRun?.error).toEqual({
      code: "out_of_credits",
      message: "The organization is out of credits.",
    });
  });

  it("ends a run once, whatever arrives after its ending", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await deliver(
      support,
      event(runId, threadId, 4, "run.completed", { output: "a", usage: null }),
    );
    await deliver(
      support,
      event(runId, threadId, 5, "run.failed", { error: { code: "x", message: "x" }, usage: null }),
    );
    expect((await read(support, threadId)).latestRun?.status).toBe("completed");
    await h.runDue();
    expect(finished).toHaveLength(1);
  });

  it("skips events of runs it does not know, so delivery never stalls", async () => {
    const support = agents();
    expect(await deliver(support, event("unknown", "t", 1, "run.started"))).toEqual({
      applied: 0,
      skipped: 1,
    });
  });

  it("stores a message too large for one document in segments", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const text = "é".repeat(700_000);
    await deliver(
      support,
      event(runId, threadId, 2, "message.completed", {
        message: {
          id: "msg_big",
          thread_id: threadId,
          run_id: runId,
          role: "assistant",
          parts: [{ type: "text", text }],
          created_at: "2026-11-15T12:00:01.000Z",
        },
      }),
    );
    const rows = h.db.all("messages").filter((row) => row["messageId"] === "msg_big");
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows)
      expect(utf8Length(JSON.stringify(row["parts"]))).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    expect((await read(support, threadId)).messages[1]?.parts).toEqual([{ type: "text", text }]);
  });
});

describe("segments", () => {
  it("cuts text without splitting a character", () => {
    const text = "a😀".repeat(10);
    const pieces = splitText(text, 7);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) expect(utf8Length(piece)).toBeLessThanOrEqual(7);
    expect(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece))).toBe(true);
  });

  it("joins segments back into the same parts", () => {
    const parts = [
      { type: "text" as const, text: "x".repeat(300) },
      {
        type: "tool_call" as const,
        id: "c",
        name: "n",
        kind: "app" as const,
        status: "succeeded" as const,
        summary: null,
      },
      { type: "text" as const, text: "y".repeat(500) },
    ];
    const segments = segmentParts(parts, 256);
    expect(segments.length).toBeGreaterThan(3);
    expect(joinSegments(segments)).toEqual(parts);
  });
});

describe("page actions", () => {
  async function withPageAction(support: HerculesAgents) {
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my order" });
    await deliver(
      support,
      event(runId, threadId, 5, "page_action", {
        tool_call_id: "call_page",
        name: "open_order",
        arguments: { orderId: "123" },
      }),
    );
    return { threadId, runId };
  }

  it("lists a delivered page action until one tab claims it", async () => {
    const support = agents();
    const { threadId, runId } = await withPageAction(support);
    expect((await read(support, threadId)).pageActions).toEqual([
      expect.objectContaining({
        toolCallId: "call_page",
        runId,
        name: "open_order",
        argumentsJson: '{"orderId":"123"}',
      }),
    ]);
    const claim = { threadId, runId, toolCallId: "call_page" };
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(true);
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(false);
    expect(await support.claimPageAction(h.appCtx(BOB), claim)).toBe(false);
    expect((await read(support, threadId)).pageActions).toEqual([]);
  });

  it("lets a tab claim from the live stream before delivery, and keeps the claim", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my order" });
    const claim = { threadId, runId, toolCallId: "call_page" };
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(true);
    await deliver(
      support,
      event(runId, threadId, 5, "page_action", {
        tool_call_id: "call_page",
        name: "open_order",
        arguments: {},
      }),
    );
    expect((await read(support, threadId)).pageActions).toEqual([]);
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(false);
  });

  it("drops a page action no tab took in time", async () => {
    const support = agents();
    const { threadId, runId } = await withPageAction(support);
    h.advance(2 * 60 * 1000 + 1);
    expect((await read(support, threadId)).pageActions).toEqual([]);
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(false);
  });
});

describe("cancel", () => {
  it("never sends a run cancelled before Hercules took it", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runDue();
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect((await read(support, threadId)).latestRun?.status).toBe("cancelled");
  });

  it("stops a run Hercules has", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(await support.cancel(h.appCtx(BOB), { threadId })).toBe(false);
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runDue();
    expect(api.requests.at(-1)?.path).toBe(`/v1/agents/runs/${runId}/cancel`);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    // The delivered ending changes nothing.
    await deliver(support, event(runId, threadId, 9, "run.cancelled", { usage: { credits: 0.5 } }));
    await h.runDue();
    expect(finished).toHaveLength(1);
  });
});

describe("deleteThread", () => {
  it("deletes the thread here and at Hercules", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(
      support,
      event(runId, threadId, 3, "message.appended", { message_id: "m", text: "Hi" }),
    );
    expect(await support.deleteThread(h.appCtx(BOB), { threadId })).toBe(false);
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    expect(await support.readThread(h.appCtx(ALICE), { threadId })).toBeNull();
    await h.runDue();
    expect(api.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/agents/threads/${threadId}`,
    });
    for (const table of ["threads", "runs", "messages", "message_chunks", "tool_calls"]) {
      expect(h.db.all(table)).toHaveLength(0);
    }
    // The run's last events find nothing and do not stall delivery.
    expect(
      await deliver(support, event(runId, threadId, 4, "run.cancelled", { usage: null })),
    ).toEqual({
      applied: 0,
      skipped: 1,
    });
  });
});

describe("the stuck-run check", () => {
  it("reads what delivery missed from Hercules", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) => {
      if (request.path.startsWith(`/v1/agents/runs/${runId}/events`)) {
        return Response.json({
          data: [
            event(runId, threadId, 2, "run.started"),
            event(runId, threadId, 8, "message.completed", {
              message: {
                id: "msg_1",
                thread_id: threadId,
                run_id: runId,
                role: "assistant",
                parts: [{ type: "text", text: "Done." }],
                created_at: "2026-11-15T12:00:01.000Z",
              },
            }),
            event(runId, threadId, 9, "run.completed", { output: "Done.", usage: { credits: 1 } }),
          ],
          has_more: false,
        });
      }
      if (request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({ id: runId, status: "completed", output: "Done." });
      }
      return undefined;
    });
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(
      api.requests.some((r) => r.path === `/v1/agents/runs/${runId}/events?after=0&limit=100`),
    ).toBe(true);
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
  });

  it("waits while events keep arriving", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    h.advance(2 * 60 * 1000);
    await deliver(support, event(runId, threadId, 2, "run.started"));
    await h.runUntil(h.now + 60 * 1000 + 1);
    expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(0);
  });

  it("fails a run Hercules has no record of", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      request.method === "GET" && request.path === `/v1/agents/runs/${runId}`
        ? Response.json({ code: "not_found" }, { status: 404 })
        : undefined,
    );
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect((await read(support, threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed" },
    });
  });
});

describe("the events route", () => {
  const SITE = "https://happy-otter-123.convex.site";
  const EVENTS_URL = `${SITE}${EVENTS_PATH}`;

  async function post(
    support: HerculesAgents,
    token: string | null,
    body: unknown,
    verifier: ReturnType<typeof createTokenVerifier>,
  ) {
    return support.handleEvents(
      h.appCtx(),
      new Request(EVENTS_URL, {
        method: "POST",
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      verifier,
    );
  }

  it("takes only Hercules's own delivery tokens for this URL", async () => {
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({
      issuer: ISSUER,
      audiences: [EVENTS_URL],
      fetch: issuer.fetch,
      now: () => NOW_MS,
    });
    const support = agents();
    const claims = {
      iss: ISSUER,
      aud: EVENTS_URL,
      sub: `agent:${AGENT_ID}`,
      hercules_principal: "hercules",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 600,
    };
    const body = { events: [] };
    expect((await post(support, null, body, verifier)).status).toBe(401);
    expect(
      (await post(support, await issuer.sign({ ...claims, aud: `${SITE}/mcp` }), body, verifier))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          support,
          await issuer.sign({ ...claims, hercules_principal: "agent" }),
          body,
          verifier,
        )
      ).status,
    ).toBe(403);
    const token = await issuer.sign(claims);
    expect((await post(support, token, "not json", verifier)).status).toBe(400);
    expect(
      (await post(support, token, { events: [{ type: "run.started" }] }, verifier)).status,
    ).toBe(400);
    const ok = await post(support, token, body, verifier);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ applied: 0, skipped: 0 });
  });

  it("is routed once, however many agents the app has", () => {
    const http = httpRouter();
    agents().registerRoutes(http);
    agents({ agentId: "agt_other" }).registerRoutes(http);
    expect(http.getRoutes().map(([path, method]) => `${method} ${path}`)).toEqual([
      `POST ${EVENTS_PATH}`,
    ]);
  });
});

describe("api()", () => {
  it("builds the functions a page calls, by the names the hooks expect", () => {
    const fns = agents().api();
    expect(Object.keys(fns).sort()).toEqual([
      "cancel",
      "claimPageAction",
      "deleteThread",
      "send",
      "thread",
    ]);
    expect(
      JSON.parse((fns.send as unknown as { exportArgs(): string }).exportArgs()).value,
    ).toHaveProperty("anonymousId");
  });
});
