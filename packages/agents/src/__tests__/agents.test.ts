import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransactionLimitError } from "../agents";
import { HerculesAgents, type AgentThread } from "../convex";
import { EVENTS_PATH, runInputText } from "../component/protocol";
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
// An agent's id is a plain ULID.
const AGENT_ID = "01JDX5ZQ8W3J2K6M9N4P7R1S0T";
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

function event(
  runId: string,
  threadId: string,
  seq: number,
  type: string,
  data: unknown = {},
  // When the event was written at Hercules. The harness's clock starts here.
  createdAt = "2026-11-15T12:00:00.000Z",
) {
  return {
    id: `${runId}:${seq}`,
    seq,
    run_id: runId,
    thread_id: threadId,
    type,
    created_at: createdAt,
    data,
  };
}

const DELIVERY_TOKEN = {
  verify: async () => ({
    ok: true as const,
    token: { issuer: ISSUER, subject: "hercules", claims: { hercules_principal: "hercules" } },
  }),
};

/** Posts a delivery to the app's HTTP route and returns the route's answer. */
async function postEvents(support: HerculesAgents, ...events: unknown[]) {
  return support.handleEvents(
    h.appCtx(),
    new Request(`https://app.convex.site${EVENTS_PATH}`, {
      method: "POST",
      body: JSON.stringify({ events }),
    }),
    DELIVERY_TOKEN,
  );
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

  it("refuses a caller who is not signed in, whatever else they send", async () => {
    const support = agents();
    const error = await support.send(h.appCtx(null), { text: "Hi" }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe("sign_in_required");
    expect(h.db.all("runs")).toHaveLength(0);

    // There are no visitors: a thread reads as nothing to someone not signed in.
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    expect(await support.readThread(h.appCtx(null), { threadId })).toBeNull();
    expect(await support.cancel(h.appCtx(null), { threadId })).toBe(false);
    expect(await support.deleteThread(h.appCtx(null), { threadId })).toBe(false);
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
      finished_at: new Date(h.now).toISOString(),
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

  it("claims only a page action the run made and Hercules delivered", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my order" });
    const claim = { threadId, runId, toolCallId: "call_page" };
    // Not delivered: an id the caller made up, or one read off the live stream too early.
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(false);
    expect(h.db.all("tool_calls")).toHaveLength(0);

    await deliver(
      support,
      event(runId, threadId, 5, "page_action", {
        tool_call_id: "call_page",
        name: "open_order",
        arguments: {},
      }),
      event(runId, threadId, 6, "tool_call.completed", {
        tool_call_id: "call_app",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: null,
      }),
    );
    // A tool call that is not a page action cannot be claimed.
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { ...claim, toolCallId: "call_app" }),
    ).toBe(false);
    // Nor a page action under another run's id.
    const other = await support.send(h.appCtx(ALICE), { text: "Another thread" });
    expect(await support.claimPageAction(h.appCtx(ALICE), { ...claim, runId: other.runId })).toBe(
      false,
    );
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { ...claim, threadId: other.threadId }),
    ).toBe(false);
    expect(await support.claimPageAction(h.appCtx(ALICE), claim)).toBe(true);
    expect(h.db.all("tool_calls")).toHaveLength(2);
  });

  it("keeps each run's tool calls apart when two runs use the same id", async () => {
    const support = agents();
    const first = await withPageAction(support);
    const second = await withPageAction(support);
    expect(h.db.all("tool_calls").map((row) => row["runId"])).toEqual([first.runId, second.runId]);
    for (const { threadId, runId } of [first, second]) {
      expect((await read(support, threadId)).pageActions).toHaveLength(1);
      expect(
        await support.claimPageAction(h.appCtx(ALICE), {
          threadId,
          runId,
          toolCallId: "call_page",
        }),
      ).toBe(true);
    }
  });

  it("drops a page action no tab took within two minutes of its event", async () => {
    const support = agents();
    const { threadId, runId } = await withPageAction(support);
    h.advance(2 * 60 * 1000 - 1);
    expect((await read(support, threadId)).pageActions).toHaveLength(1);
    h.advance(1);
    expect((await read(support, threadId)).pageActions).toEqual([]);
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(false);
  });

  it("never offers a page action that was delivered late", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my order" });
    await h.runDue();
    const written = new Date(h.now).toISOString();
    // Delivery was held up for an hour: the event is as old as when it was written.
    h.advance(60 * 60 * 1000);
    await deliver(
      support,
      event(
        runId,
        threadId,
        5,
        "page_action",
        { tool_call_id: "call_late", name: "open_order", arguments: { orderId: "123" } },
        written,
      ),
      // An event that does not say when it was written is not known to be recent.
      event(
        runId,
        threadId,
        6,
        "page_action",
        { tool_call_id: "call_undated", name: "open_order", arguments: {} },
        "",
      ),
    );
    expect(h.db.all("tool_calls")).toHaveLength(2);
    expect((await read(support, threadId)).pageActions).toEqual([]);
    for (const toolCallId of ["call_late", "call_undated"]) {
      expect(await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId })).toBe(
        false,
      );
    }
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

  it("fails a run Hercules has no record of only once it has said so for an hour", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    let missing = true;
    api.answerWith((request) =>
      missing && request.method === "GET" && request.path === `/v1/agents/runs/${runId}`
        ? Response.json({ code: "not_found" }, { status: 404 })
        : undefined,
    );
    // Hercules also answers 404 while it cannot tell whether the API is on for the app.
    await h.runUntil(h.now + 30 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    // It answers again: the hour starts over the next time.
    missing = false;
    await h.runUntil(h.now + 6 * 60 * 1000);
    missing = true;
    await h.runUntil(h.now + 50 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await h.runUntil(h.now + 15 * 60 * 1000);
    expect((await read(support, threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: "Hercules has no record of this run." },
    });
    expect(h.scheduled.map((job) => job.name)).not.toContain("hercules:checkRun");
  });
});

/** Runs only the jobs `keep` picks, dropping the rest: a scheduled action Convex lost. */
async function runOnly(keep: (name: string) => boolean, untilMs: number) {
  for (let i = 0; i < 2000; i++) {
    const jobs = h.takeScheduled();
    const kept = jobs.filter((job) => keep(job.name)).sort((a, b) => a.at - b.at);
    const next = kept.find((job) => job.at <= untilMs);
    // Put back what is not run now. `takeScheduled` emptied the list.
    for (const job of kept) if (job !== next) h.scheduled.push(job);
    if (next === undefined) {
      h.advance(Math.max(0, untilMs - h.now));
      return;
    }
    h.advance(Math.max(0, next.at - h.now));
    await h.call(next.ref as never, next.args);
  }
  throw new Error("runOnly: too many jobs");
}

function isStart(request: Recorded): boolean {
  return request.method === "POST" && /^\/v1\/agents\/[^/]+\/runs$/.test(request.path);
}

function problem(status: number, code: string, detail: string, retryAfter?: number) {
  return new Response(JSON.stringify({ code, detail }), {
    status,
    headers: {
      "content-type": "application/problem+json",
      ...(retryAfter !== undefined && { "retry-after": String(retryAfter) }),
    },
  });
}

describe("limits and refusals at Hercules", () => {
  it.each([
    ["agent_daily_limit_reached", "The agent's daily credit limit is reached.", 20_000],
    ["end_user_rate_limited", "Too many runs this hour.", 1_800],
  ])("ends the run at once on %s, with how long the limit lasts", async (code, detail, wait) => {
    const support = agents();
    api.answerWith((request) => (isStart(request) ? problem(429, code, detail, wait) : undefined));
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await h.runDue();
    // One call, no retry, and the thread is free at once.
    expect(api.requests.filter(isStart)).toHaveLength(1);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toEqual({
      id: runId,
      status: "failed",
      error: { code, message: detail, retryAfterSeconds: wait },
      cappedReason: null,
      finished_at: new Date(sentAt).toISOString(),
    });
    expect(finished).toEqual([
      expect.objectContaining({ runId, error: { code, message: detail, retryAfterSeconds: wait } }),
    ]);
    await support.send(h.appCtx(ALICE), { threadId, text: "Again" });
  });

  it("retries rate_limited, the one 429 that passes by itself, as told", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls <= 2 ? problem(429, "rate_limited", "Slow down.", 7) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await h.runUntil(h.now + 13_999);
    expect(api.requests.filter(isStart)).toHaveLength(2);
    await h.runUntil(sentAt + 14_000);
    expect(api.requests.filter(isStart)).toHaveLength(3);
    expect((await read(support, threadId)).activeRun).toMatchObject({
      id: runId,
      live: { token: `token-${runId}` },
    });
  });

  it("reports rate_limited, not an unreachable Hercules, when it never passes", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request) ? problem(429, "rate_limited", "Slow down.", 1) : undefined,
    );
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    expect(api.requests.filter(isStart)).toHaveLength(8);
    expect((await read(support, threadId)).latestRun?.error).toEqual({
      code: "rate_limited",
      message: "Slow down.",
      retryAfterSeconds: 1,
    });
  });

  it("waits out a thread Hercules still holds for the run before", async () => {
    const support = agents();
    let busy = 3;
    api.answerWith((request) =>
      isStart(request) && busy-- > 0
        ? problem(409, "thread_busy", "A run is still going on this thread.")
        : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 10_000);
    expect(api.requests.filter(isStart)).toHaveLength(4);
    expect((await read(support, threadId)).activeRun?.live?.token).toBe(`token-${runId}`);
  });

  it("gives up on a busy thread after a minute, with Hercules's code", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request) ? problem(409, "thread_busy", "A run is still going.") : undefined,
    );
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await h.runUntil(h.now + 59_000);
    expect((await read(support, threadId)).activeRun).not.toBeNull();
    await h.runUntil(sentAt + 70_000);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.error).toEqual({
      code: "thread_busy",
      message: "A run is still going.",
    });
    expect(Date.parse(thread.latestRun?.finished_at ?? "") - sentAt).toBeLessThan(66_000);
  });

  it("settles a run at once when Hercules answers that it is already over", async () => {
    const support = agents();
    api.answerWith((request) => {
      if (isStart(request)) {
        return Response.json({
          run: {
            id: request.body.run_id,
            thread_id: request.body.thread_id,
            status: "completed",
            output: "Done.",
            usage: { credits: 1 },
          },
          live: { url: `${API_URL}/live`, token: "tok" },
        });
      }
      if (/\/events\?/.test(request.path)) {
        const [, runId] = /runs\/([^/]+)\/events/.exec(request.path) ?? [];
        const run = h.db.all("runs").find((row) => row["runId"] === runId);
        const threadId = run?.["threadId"] as string;
        return Response.json({
          data: [
            event(runId as string, threadId, 3, "message.completed", {
              message: {
                id: "msg_1",
                thread_id: threadId,
                run_id: runId,
                role: "assistant",
                parts: [{ type: "text", text: "Done." }],
                created_at: "2026-11-15T12:00:01.000Z",
              },
            }),
          ],
          has_more: false,
        });
      }
      return undefined;
    });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({ id: runId, status: "completed" });
    // With what the run wrote, read before its ending was recorded.
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
    expect(finished).toEqual([expect.objectContaining({ runId, output: "Done." })]);
  });

  it("refuses to send the app key to a URL that is not https", async () => {
    for (const apiUrl of ["http://api.hercules.test", "ftp://api.hercules.test", "not a url"]) {
      await expect(agents({ apiUrl }).send(h.appCtx(ALICE), { text: "Hi" })).rejects.toThrow(
        /https/,
      );
    }
    expect(h.db.all("runs")).toHaveLength(0);
    // A local API is fine in development.
    await agents({ apiUrl: "http://localhost:8787" }).send(h.appCtx(ALICE), { text: "Hi" });
    await agents({ apiUrl: "http://127.0.0.1:8787" }).send(h.appCtx(ALICE), { text: "Hi" });
  });

  it("measures input the way Hercules does, context wrapper included", async () => {
    const support = agents();
    const context = { page: "/orders/1", filters: { status: "open" } };
    expect(runInputText("Hi", context)).toBe(
      'Hi\n\n<page_context>\n{\n  "page": "/orders/1",\n  "filters": {\n    "status": "open"\n  }\n}\n</page_context>',
    );
    expect(runInputText("Hi", {})).toBe("Hi");
    const room = 262_144 - runInputText("", context).length;
    const error = await support
      .send(h.appCtx(ALICE), { text: "x".repeat(room + 1), context })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("message_too_long");
    expect(h.db.all("threads")).toHaveLength(0);
    expect(h.db.all("messages")).toHaveLength(0);
    await support.send(h.appCtx(ALICE), { text: "x".repeat(room), context });
  });
});

describe("a start call that was lost", () => {
  const notStart = (name: string) => name !== "hercules:startRun";

  it("is made again by the stuck-run check", async () => {
    const support = agents({ pageActions: ["open_order"] });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), {
      text: "Hi",
      context: { page: "/orders" },
    });
    // Convex runs a scheduled action at most once: this one never ran.
    await runOnly(notStart, h.now + 3 * 60 * 1000);
    const starts = api.requests.filter(isStart);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.body).toEqual({
      run_id: runId,
      thread_id: threadId,
      end_user: { token_identifier: ALICE },
      input: [{ type: "text", text: "Hi" }],
      context: { page: "/orders" },
      page_actions: ["open_order"],
    });
    expect((await read(support, threadId)).activeRun).toMatchObject({
      id: runId,
      live: { token: `token-${runId}` },
    });
  });

  it("does not send the run twice while the start call is still trying", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls === 1 ? problem(429, "rate_limited", "Wait.", 400) : undefined,
    );
    await support.send(h.appCtx(ALICE), { text: "Hi" });
    // The check at three minutes leaves the run to the retry due at 400 seconds.
    await h.runUntil(h.now + 399_000);
    expect(api.requests.filter(isStart)).toHaveLength(1);
    await h.runUntil(h.now + 2_000);
    expect(api.requests.filter(isStart)).toHaveLength(2);
  });

  it("takes over a retry that was lost", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls === 1 ? new Response("down", { status: 503 }) : undefined,
    );
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // The first try ran and scheduled a retry, which is lost.
    expect(h.scheduled.map((job) => job.name).sort()).toEqual([
      "hercules:checkRun",
      "hercules:startRun",
    ]);
    await runOnly(notStart, h.now + 6 * 60 * 1000);
    expect(api.requests.filter(isStart)).toHaveLength(2);
    expect((await read(support, threadId)).activeRun?.live).not.toBeNull();
  });

  it("honors a cancel", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(true);
    // Hercules may have the run (the call can die after it was answered), so it is asked to stop it.
    api.answerWith((request) =>
      request.path === `/v1/agents/runs/${runId}/cancel`
        ? Response.json({ code: "not_found" }, { status: 404 })
        : undefined,
    );
    await runOnly(notStart, h.now + 3 * 60 * 1000);
    expect(api.requests.map((r) => r.path)).toEqual([`/v1/agents/runs/${runId}/cancel`]);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });

  it("stops a run Hercules did take before the call was lost", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await support.cancel(h.appCtx(ALICE), { threadId });
    await runOnly(notStart, h.now + 3 * 60 * 1000);
    expect(api.requests.map((r) => r.path)).toEqual([`/v1/agents/runs/${runId}/cancel`]);
    expect((await read(support, threadId)).latestRun?.status).toBe("cancelled");
  });

  it("gives up after a day, so the thread is free and nothing loops", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request) ? new Response("down", { status: 503 }) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await runOnly(notStart, h.now + 23 * 60 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    // It kept asking, every three minutes.
    expect(api.requests.filter(isStart).length).toBeGreaterThan(400);
    await runOnly(notStart, sentAt + 24 * 60 * 60 * 1000 + 4 * 60 * 1000);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: "The run could not be started within a day." },
    });
    // The check is over, and the app heard about the run.
    await h.runUntil(h.now + 60 * 60 * 1000 + 1);
    expect(h.scheduled).toEqual([]);
    expect(finished).toEqual([expect.objectContaining({ runId, status: "failed" })]);
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });
});

describe("the live token", () => {
  it("is stored by a retried start call even after an event marked the run accepted", async () => {
    const support = agents();
    let first = true;
    api.answerWith((request) => {
      if (!isStart(request) || !first) return undefined;
      // Hercules took the run, and the answer was lost on the way back.
      first = false;
      return new Response("gateway timeout", { status: 504 });
    });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(support, event(runId, threadId, 1, "run.queued"));
    expect((await read(support, threadId)).activeRun).toMatchObject({ live: null });
    await h.runUntil(h.now + 60_000);
    expect(api.requests.filter(isStart)).toHaveLength(2);
    // The same token as the first call would have returned: it does not rotate.
    expect((await read(support, threadId)).activeRun?.live).toEqual({
      url: `${API_URL}/v1/agents/runs/${runId}/events`,
      token: `token-${runId}`,
    });
  });

  it("never fails a run that is going because asking for its token was refused", async () => {
    const support = agents();
    let starts = 0;
    api.answerWith((request) => {
      if (!isStart(request)) return undefined;
      // The first answer is lost. Every later one refuses, as a quota would.
      return ++starts === 1
        ? new Response("gateway timeout", { status: 504 })
        : problem(429, "end_user_rate_limited", "Too many runs this hour.", 1_800);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(support, event(runId, threadId, 2, "run.started"));
    await h.runUntil(h.now + 60_000);
    expect(starts).toBe(2);
    // Hercules has the run: it goes on with no live stream, and the reply is delivered.
    expect((await read(support, threadId)).activeRun).toMatchObject({
      id: runId,
      status: "running",
      live: null,
    });
    await deliver(
      support,
      event(runId, threadId, 9, "run.completed", { output: "Done.", usage: { credits: 1 } }),
    );
    errors.mockRestore();
    expect((await read(support, threadId)).latestRun).toMatchObject({ status: "completed" });
  });

  it("is dropped an hour after the run ends, when it expires", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const stored = () => h.db.all("runs").find((row) => row["runId"] === runId);
    expect(stored()?.["liveToken"]).toBe(`token-${runId}`);
    await deliver(
      support,
      event(runId, threadId, 4, "run.completed", { output: "a", usage: null }),
    );
    // Still good for replaying the run's live events.
    await h.runUntil(h.now + 60 * 60 * 1000 - 1);
    expect(stored()?.["liveToken"]).toBe(`token-${runId}`);
    await h.runUntil(h.now + 1);
    expect(stored()).toMatchObject({ liveToken: null, liveUrl: null });
  });

  it("is dropped with the thread", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // More rows than one purge batch deletes, so the run row outlives the mutation.
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    expect(h.db.all("runs").map((row) => row["liveToken"])).toEqual([null]);
    await h.runDue();
    expect(h.db.all("runs")).toEqual([]);
    expect(h.db.all("run_requests")).toEqual([]);
  });
});

describe("tool details", () => {
  const message = (threadId: string, runId: string) => ({
    id: "msg_1",
    thread_id: threadId,
    run_id: runId,
    role: "assistant",
    parts: [
      {
        type: "tool_call",
        id: "call_search",
        name: "web_search",
        kind: "hercules",
        status: "succeeded",
        summary: "Searched the web for refund policy",
      },
      {
        type: "tool_call",
        id: "call_mail",
        name: "gmail_send",
        kind: "hercules",
        status: "failed",
        summary: "Could not send the email to bob@example.com",
      },
      {
        type: "tool_call",
        id: "call_order",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
      },
      {
        type: "tool_call",
        id: "call_page",
        name: "open_order",
        kind: "page",
        status: "sent",
        summary: null,
      },
      { type: "text", text: "Here is your order." },
    ],
    created_at: "2026-11-15T12:00:01.000Z",
  });

  async function runWithTools(support: HerculesAgents) {
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Where is it?" });
    await h.runDue();
    await deliver(
      support,
      event(runId, threadId, 3, "tool_call.completed", {
        tool_call_id: "call_search",
        name: "web_search",
        kind: "hercules",
        status: "succeeded",
        summary: "Searched the web for refund policy",
      }),
      event(runId, threadId, 4, "tool_call.completed", {
        tool_call_id: "call_order",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
        result: { id: "123", email: "alice@example.com" },
      }),
      event(runId, threadId, 5, "message.completed", { message: message(threadId, runId) }),
    );
    return { threadId, runId };
  }

  it("keeps Hercules tool names and every tool result from the page by default", async () => {
    const support = agents();
    const { threadId } = await runWithTools(support);
    expect(api.requests.find(isStart)?.body).not.toHaveProperty("expose_tool_details");
    const thread = await read(support, threadId);
    expect(thread.messages[1]?.parts).toEqual([
      {
        type: "tool_call",
        id: "call_search",
        name: "tool",
        kind: "hercules",
        status: "succeeded",
        summary: "Used a tool",
      },
      {
        type: "tool_call",
        id: "call_mail",
        name: "tool",
        kind: "hercules",
        status: "failed",
        summary: "Couldn't use a tool",
      },
      // The app's own tools and page actions are the app's to show.
      {
        type: "tool_call",
        id: "call_order",
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
      },
      {
        type: "tool_call",
        id: "call_page",
        name: "open_order",
        kind: "page",
        status: "sent",
        summary: null,
      },
      { type: "text", text: "Here is your order." },
    ]);
    const shown = JSON.stringify(thread);
    for (const hidden of [
      "web_search",
      "gmail_send",
      "refund policy",
      "bob@",
      "alice@",
      "result",
    ]) {
      expect(shown).not.toContain(hidden);
    }
  });

  it("shows the page the tool calls as stored when the app opts in", async () => {
    const support = agents({ exposeToolDetails: true });
    const { threadId, runId } = await runWithTools(support);
    expect(api.requests.find(isStart)?.body).toMatchObject({ expose_tool_details: true });
    const thread = await read(support, threadId);
    expect(thread.messages[1]?.parts).toEqual(message(threadId, runId).parts);
  });

  it("sends a retried start with the same expose_tool_details", async () => {
    const support = agents({ exposeToolDetails: true });
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls <= 2 ? new Response("busy", { status: 503 }) : undefined,
    );
    await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    const bodies = api.requests.filter(isStart).map((request) => JSON.stringify(request.body));
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('"expose_tool_details":true');
  });

  it("gives the app's backend everything as delivered, whatever the page may see", async () => {
    const support = agents();
    const { threadId, runId } = await runWithTools(support);
    // No ctx.auth: it is the app's own read.
    const details = await support.readThreadDetails(h.appCtx(), { threadId });
    expect(details?.messages[1]?.parts).toEqual(message(threadId, runId).parts);
    expect(details?.toolCallsTruncated).toBe(false);
    expect(details?.toolCalls).toEqual([
      {
        toolCallId: "call_search",
        runId,
        name: "web_search",
        kind: "hercules",
        status: "succeeded",
        summary: "Searched the web for refund policy",
        resultJson: null,
        argumentsJson: null,
        created_at: "2026-11-15T12:00:00.000Z",
      },
      {
        toolCallId: "call_order",
        runId,
        name: "lookup_order",
        kind: "app",
        status: "succeeded",
        summary: "Looked up order 123",
        resultJson: '{"id":"123","email":"alice@example.com"}',
        argumentsJson: null,
        created_at: "2026-11-15T12:00:00.000Z",
      },
    ]);
    // Another agent's instance does not read this agent's threads.
    const other = agents({ agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0V" });
    expect(await other.readThreadDetails(h.appCtx(), { threadId })).toBeNull();
    expect(await support.readThreadDetails(h.appCtx(), { threadId: "nope" })).toBeNull();
  });
});

describe("a large batch on a run with a long input", () => {
  it("writes the run document once, and never the input again", async () => {
    const support = agents();
    const input = "x".repeat(200_000);
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: input });
    await h.runDue();

    const db = h.db as unknown as {
      patch(id: string, fields: Record<string, unknown>): Promise<void>;
      insert(table: string, value: Record<string, unknown>): Promise<string>;
      get(id: string): Promise<Record<string, unknown> | null>;
    };
    const original = { patch: db.patch.bind(db), insert: db.insert.bind(db), get: db.get.bind(db) };
    let runWrites = 0;
    let bytesWritten = 0;
    db.patch = async (id, fields) => {
      await original.patch(id, fields);
      if (id.startsWith("runs:")) runWrites++;
      // A patch rewrites the whole document.
      bytesWritten += JSON.stringify(await original.get(id)).length;
    };
    db.insert = async (table, value) => {
      bytesWritten += JSON.stringify(value).length;
      return original.insert(table, value);
    };

    const events = [];
    for (let seq = 2; seq < 102; seq++) {
      events.push(
        seq % 2 === 1
          ? event(runId, threadId, seq, "run.progress", { label: `Step ${seq}` })
          : event(runId, threadId, seq, "tool_call.completed", {
              tool_call_id: `call_${seq}`,
              name: "lookup_order",
              kind: "app",
              status: "succeeded",
              summary: "ok",
            }),
      );
    }
    expect(await deliver(support, ...events)).toEqual({ applied: 100, skipped: 0 });
    Object.assign(db, original);

    expect(runWrites).toBe(1);
    // It was megabytes when each event rewrote a run document that held the input.
    expect(bytesWritten).toBeLessThan(100_000);
    expect(JSON.stringify(h.db.all("runs"))).not.toContain("xxxx");
    expect((await read(support, threadId)).activeRun).toMatchObject({
      status: "running",
      progress: "Step 101",
      lastSeq: 101,
    });
  });

  it("ends a run in the same single write when the batch holds its ending", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const db = h.db as unknown as { patch(id: string, fields: unknown): Promise<void> };
    const patch = db.patch.bind(db);
    const runPatches: unknown[] = [];
    db.patch = async (id, fields) => {
      if (id.startsWith("runs:")) runPatches.push(fields);
      return patch(id, fields);
    };
    await deliver(
      support,
      event(runId, threadId, 2, "run.started"),
      event(runId, threadId, 3, "run.progress", { label: "Thinking" }),
      event(runId, threadId, 4, "run.completed", { output: "Done.", usage: { credits: 1 } }),
    );
    db.patch = patch;
    expect(runPatches).toHaveLength(1);
    expect(runPatches[0]).toMatchObject({ status: "completed", lastSeq: 4, progress: "Thinking" });
    expect((await read(support, threadId)).latestRun?.status).toBe("completed");
  });
});

describe("a batch the app cannot apply", () => {
  function failPatches(message: string) {
    const db = h.db as unknown as { patch(id: string, fields: unknown): Promise<void> };
    const patch = db.patch.bind(db);
    db.patch = async (id, fields) => {
      if (id.startsWith("runs:")) throw new Error(message);
      return patch(id, fields);
    };
    return () => {
      db.patch = patch;
    };
  }

  it("answers 413 when it is more than one transaction holds, so Hercules halves it", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = failPatches(
      "Too many bytes written in a single function execution (limit: 16777216 bytes)",
    );
    const response = await postEvents(support, event(runId, threadId, 2, "run.started"));
    expect(response.status).toBe(413);
    restore();
    // Nothing of the batch stayed, so the smaller one applies cleanly.
    expect(await deliver(support, event(runId, threadId, 2, "run.started"))).toEqual({
      applied: 1,
      skipped: 0,
    });
    errors.mockRestore();
  });

  it("answers 500 for any other failure", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = failPatches("Cannot read properties of undefined");
    const response = await postEvents(support, event(runId, threadId, 2, "run.started"));
    expect(response.status).toBe(500);
    restore();
    errors.mockRestore();
  });

  it.each([
    ["Too many bytes read in a single function execution (limit: 16777216 bytes)", true],
    ["Too many documents read in a single function execution (limit: 32000)", true],
    ["Too many writes in a single function execution (limit: 16000)", true],
    ["Value is too large (1.2 MiB > maximum size 1 MiB)", true],
    ["Function execution timed out (maximum duration: 1s)", true],
    ["Validator error: Expected `string`, got `null`", false],
    ["Uncaught TypeError: x is not a function", false],
  ])("reads %s as a limit: %s", (message, limit) => {
    expect(isTransactionLimitError(new Error(message))).toBe(limit);
  });
});

describe("the stuck-run check, when Hercules or the app cannot answer", () => {
  function completed(runId: string, threadId: string) {
    return [
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
    ];
  }

  it("leaves the run open when its events cannot be read, and settles it with them later", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    let eventsDown = true;
    api.answerWith((request) => {
      if (request.path.startsWith(`/v1/agents/runs/${runId}/events`)) {
        return eventsDown
          ? new Response("down", { status: 503 })
          : Response.json({ data: completed(runId, threadId), has_more: false });
      }
      if (request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({ id: runId, status: "completed", output: "Done." });
      }
      return undefined;
    });
    await h.runUntil(h.now + 7 * 60 * 1000);
    // Hercules says the run is over, but ending it now would end it without its reply.
    let thread = await read(support, threadId);
    expect(thread.activeRun?.id).toBe(runId);
    expect(thread.messages).toHaveLength(1);
    expect(finished).toEqual([]);

    eventsDown = false;
    await h.runUntil(h.now + 3 * 60 * 1000);
    thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
    expect(finished).toHaveLength(1);
  });

  it("reads every page of events before it records the ending", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const all = completed(runId, threadId);
    const pages: string[] = [];
    api.answerWith((request) => {
      const match = /\/events\?after=(\d+)/.exec(request.path);
      if (match !== null) {
        pages.push(match[1] as string);
        const rest = all.filter((entry) => entry.seq > Number(match[1]));
        // One event a page.
        return Response.json({ data: rest.slice(0, 1), has_more: rest.length > 1 });
      }
      if (request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({ id: runId, status: "completed", output: "Done." });
      }
      return undefined;
    });
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(pages).toEqual(["0", "2", "8"]);
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
  });

  it("keeps checking when applying what it read throws", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) => {
      if (request.path.startsWith(`/v1/agents/runs/${runId}/events`)) {
        return Response.json({ data: completed(runId, threadId), has_more: false });
      }
      if (request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({ id: runId, status: "completed", output: "Done." });
      }
      return undefined;
    });
    const db = h.db as unknown as { insert(table: string, value: unknown): Promise<string> };
    const insert = db.insert.bind(db);
    db.insert = async (table, value) => {
      if (table === "messages") throw new Error("Too many bytes written (limit: 16777216 bytes)");
      return insert(table, value);
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runUntil(h.now + 3 * 60 * 1000);
    // It halved the batch down to the event that cannot be applied, applied what
    // came before it, and left the run open with the check still scheduled.
    expect(h.db.all("runs")[0]).toMatchObject({ status: "running", lastSeq: 2 });
    expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:checkRun"]);
    expect(finished).toEqual([]);

    db.insert = insert;
    await h.runUntil(h.now + 3 * 60 * 1000);
    errors.mockRestore();
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
  });

  it("comes back even when the check itself throws", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      request.path === `/v1/agents/runs/${runId}`
        ? Response.json({ id: runId, status: "completed", output: "Done." })
        : undefined,
    );
    // Recording the run's ending fails, which the check does not handle itself.
    const db = h.db as unknown as { patch(id: string, fields: unknown): Promise<void> };
    const patch = db.patch.bind(db);
    db.patch = async (id, fields) => {
      if (id.startsWith("runs:")) throw new Error("the database is unhappy");
      return patch(id, fields);
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:checkRun"]);
    db.patch = patch;
    await h.runUntil(h.now + 3 * 60 * 1000);
    errors.mockRestore();
    expect((await read(support, threadId)).latestRun?.status).toBe("completed");
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
    agents({ agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0V" }).registerRoutes(http);
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
    const argsOf = (fn: unknown) =>
      Object.keys(JSON.parse((fn as { exportArgs(): string }).exportArgs()).value).sort();
    expect(argsOf(fns.send)).toEqual(["context", "text", "threadId"]);
    expect(argsOf(fns.thread)).toEqual(["limit", "threadId"]);
    expect(argsOf(fns.cancel)).toEqual(["threadId"]);
    expect(argsOf(fns.claimPageAction)).toEqual(["runId", "threadId", "toolCallId"]);
    expect(argsOf(fns.deleteThread)).toEqual(["threadId"]);
  });
});
