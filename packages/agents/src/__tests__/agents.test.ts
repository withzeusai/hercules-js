import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerculesAgents, type AgentThread } from "../convex";
import { retryDelayMs } from "../component/hercules";
import {
  EVENTS_PATH,
  hasRunEnded,
  isFinalStatus,
  readRun,
  runInputText,
} from "../component/protocol";
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
import packageJson from "../../package.json";
import { CLIENT_ID, PACKAGE_VERSION } from "../component/protocol";

declare global {
  interface ImportMeta {
    /** Vite's: the files a pattern matches, read when the tests are built. */
    glob(
      pattern: string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

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

/**
 * Who a request to Hercules must name as its end user, from what the
 * component stored: the run's row, or the deleted thread's. Undefined when
 * neither is there to say (a run purged with its thread).
 */
function storedEndUser(request: Recorded): string | null | undefined {
  const ofOwner = (owner: unknown) =>
    typeof owner === "string" && owner.startsWith("user:") ? owner.slice(5) : null;
  const runId =
    /^\/v1\/agents\/runs\/([^/?]+)/.exec(request.path)?.[1] ??
    (request.body?.run_id as string | undefined);
  if (runId !== undefined) {
    const run = h.db.all("runs").find((row) => row["runId"] === runId);
    return run === undefined ? undefined : ofOwner(run["owner"]);
  }
  const threadId = /^\/v1\/agents\/threads\/([^/?]+)/.exec(request.path)?.[1];
  const deleted = h.db.all("deleted_threads").find((row) => row["threadId"] === threadId);
  // A row written before the owner was kept says nothing.
  return deleted === undefined || !("owner" in deleted) ? undefined : ofOwner(deleted["owner"]);
}

/** A stand-in Hercules API: records every request and answers from `routes`. */
function createFakeHercules() {
  const requests: Recorded[] = [];
  /** Requests that did not name the end user the component has stored for them. */
  const misnamed: string[] = [];
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
    // Held to in every test of this file: whatever path led to a request, it
    // names the user whose thread or run it is about, and no one otherwise.
    const expected = storedEndUser(request);
    const header = request.headers.get("hercules-end-user");
    // As Hercules reads it: as it is, or percent-encoded after `UTF-8''`.
    const sent =
      header !== null && header.startsWith("UTF-8''")
        ? decodeURIComponent(header.slice("UTF-8''".length))
        : header;
    if (expected !== undefined && sent !== expected) {
      misnamed.push(`${request.method} ${request.path}: sent ${sent}, stored ${expected}`);
    }
    return answer(request) ?? defaultAnswer(request);
  }) as typeof fetch;

  return {
    requests,
    misnamed,
    fetch: fetchFn,
    answerWith(next: (request: Recorded) => Response | undefined) {
      answer = next;
    },
  };
}

let h: Harness;
let api: ReturnType<typeof createFakeHercules>;
let finished: unknown[];
let noJitter: ReturnType<typeof vi.spyOn>;

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
  // Every wait the component schedules is jittered. With no jitter the tests
  // can say when things happen; the jitter has tests of its own.
  noJitter = vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  expect(api.misnamed).toEqual([]);
  noJitter.mockRestore();
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

  it("opens a thread under the id the page chose, and sends in it after", async () => {
    const support = agents();
    const chosen = "9c2d7a10-55e1-4f0b-8d3c-2a1b0c9d8e7f";
    const first = await support.send(h.appCtx(ALICE), { threadId: chosen, text: "Hi" });
    expect(first.threadId).toBe(chosen);
    await h.runDue();
    expect(api.requests[0]?.body.thread_id).toBe(chosen);
    expect((await read(support, chosen)).messages).toHaveLength(1);

    // A ULID works too.
    const ulid = "01JDX5ZQ8W3J2K6M9N4P7R1S0T";
    expect((await support.send(h.appCtx(ALICE), { threadId: ulid, text: "Hi" })).threadId).toBe(
      ulid,
    );
    // Someone else's thread still reads as one that does not exist.
    const error = await support
      .send(h.appCtx(BOB), { threadId: chosen, text: "Me too" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("not_found");
  });

  it.each([
    ["a name", "support-chat"],
    // Hercules stores a UUID in lowercase and takes a ULID in uppercase only:
    // in any other form the id would name a different thread there than here.
    ["a UUID in uppercase", "9C2D7A10-55E1-4F0B-8D3C-2A1B0C9D8E7F"],
    ["a ULID in lowercase", "01jdx5zq8w3j2k6m9n4p7r1s0t"],
    ["a ULID past the largest time", "81JDX5ZQ8W3J2K6M9N4P7R1S0T"],
    ["a UUID with no dashes", "9c2d7a1055e14f0b8d3c2a1b0c9d8e7f"],
    ["nothing", ""],
  ])("refuses %s as a new thread's id, before anything is written", async (_name, threadId) => {
    const error = await agents()
      .send(h.appCtx(ALICE), { threadId, text: "Hi" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("invalid_request");
    for (const table of ["threads", "runs", "run_requests", "messages"]) {
      expect(h.db.all(table)).toHaveLength(0);
    }
    expect(h.scheduled).toEqual([]);
  });

  it("refuses a caller who is not signed in, whatever else they send", async () => {
    const support = agents();
    const error = await support.send(h.appCtx(null), { text: "Hi" }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe("sign_in_required");
    expect(h.db.all("runs")).toHaveLength(0);

    // A thread reads as nothing to someone not signed in.
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

  it("keeps counting the runs of a deleted thread toward the hourly limit", async () => {
    const support = agents({ limits: { runsPerUserPerHour: 2 } });
    const sentAt = h.now;
    const one = await support.send(h.appCtx(ALICE), { text: "One" });
    const two = await support.send(h.appCtx(ALICE), { text: "Two" });
    await h.runDue();
    // Deleting both threads purges their runs. It does not give them back.
    for (const { threadId } of [one, two]) {
      expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    }
    await h.runDue();
    expect(h.db.all("runs")).toEqual([]);
    expect(h.db.all("purged_run_starts")).toEqual([
      expect.objectContaining({ owner: `user:${ALICE}`, agentId: AGENT_ID }),
      expect.objectContaining({ owner: `user:${ALICE}`, agentId: AGENT_ID }),
    ]);
    h.advance(10 * 60 * 1000);
    const error = await support.send(h.appCtx(ALICE), { text: "Three" }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe("end_user_rate_limited");
    // Counted from when the oldest run was sent, as if its thread were still there.
    const { retryAfterSeconds } = (error as ConvexError<{ retryAfterSeconds: number }>).data;
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(50 * 60);
    expect(retryAfterSeconds).toBeLessThanOrEqual(50 * 60 + 1);
    // Someone else is not held back.
    await support.send(h.appCtx(BOB), { text: "One" });

    // The hour passes, and with it what was kept of the purged runs.
    await h.runUntil(sentAt + 60 * 60 * 1000 + 1_000, 2000);
    expect(h.db.all("purged_run_starts")).toEqual([]);
    await support.send(h.appCtx(ALICE), { text: "Three" });
  });

  it("keeps nothing of a purged run that no longer counts, or that is the app's own", async () => {
    const support = agents({ limits: { runsPerUserPerHour: 2 } });
    const old = await support.send(h.appCtx(ALICE), { text: "An hour ago" });
    const job = await support.run(h.appCtx(), { text: "Summarize today's orders" });
    await h.runDue();
    h.advance(60 * 60 * 1000 + 1);
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId: old.threadId })).toBe(true);
    // The app's own thread is deleted through the component, as the app's backend would.
    expect(
      await h.call(h.component.threads.remove, {
        threadId: job.threadId,
        agentId: AGENT_ID,
        owner: "app",
        api: { key: "hercules-app-key", url: API_URL },
      }),
    ).toBe(true);
    await h.runDue();
    expect(h.db.all("runs")).toEqual([]);
    expect(h.db.all("purged_run_starts")).toEqual([]);
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

describe("what Hercules adds later", () => {
  /** A reply with every kind of thing this version does not know, beside what it does. */
  function replyWithNewThings(threadId: string, runId: string) {
    return {
      id: "msg_1",
      thread_id: threadId,
      run_id: runId,
      role: "assistant",
      parts: [
        { type: "text", text: "Here you go.", annotations: [{ start: 0, end: 4 }] },
        // A part type added later.
        { type: "reasoning", text: "Thinking it over.", signature: "abc" },
        // A tool kind added later.
        {
          type: "tool_call",
          id: "call_new_kind",
          name: "search_tickets",
          kind: "connector",
          status: "succeeded",
          summary: "Searched tickets",
        },
        // A tool status added later.
        {
          type: "tool_call",
          id: "call_new_status",
          name: "refund_order",
          kind: "app",
          status: "denied",
          summary: "Refund order was not approved",
        },
        { type: "image", url: "https://example.test/a.png" },
        { type: "text", text: " Anything else?" },
      ],
      created_at: "2026-11-15T12:00:01.000Z",
      // A field added later.
      model: "a-model",
    };
  }

  it("applies the events it knows from a batch that mixes in ones it does not, and answers 2xx", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const response = await support.handleEvents(
      h.appCtx(),
      new Request(`https://app.convex.site${EVENTS_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          // Keys of the batch itself that this version does not know.
          delivery_id: "dlv_1",
          attempt: 3,
          events: [
            event(runId, threadId, 1, "run.queued"),
            { ...event(runId, threadId, 2, "run.started"), trace: { id: "t" }, final: false },
            event(runId, threadId, 3, "reasoning.delta", { text: "Hm." }),
            event(runId, threadId, 4, "message.appended", { message_id: "msg_1", text: "Here" }),
            event(runId, threadId, 5, "run.requires_action", { action: { $ref: "#/x" } }),
            // Entries that are not events at all.
            "not an event",
            { type: "no.envelope" },
            event(runId, threadId, 6, "run.progress", { label: "Looking", percent: 40 }),
          ],
        }),
      }),
      DELIVERY_TOKEN,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 6, skipped: 2 });
    const thread = await read(support, threadId);
    expect(thread.activeRun).toMatchObject({ status: "running", lastSeq: 6, progress: "Looking" });
    expect(thread.messages[1]).toMatchObject({
      status: "streaming",
      parts: [{ type: "text", text: "Here" }],
    });
    expect(finished).toEqual([]);
  });

  it("keeps a message's known parts beside ones it does not know, and reads new tool kinds and statuses", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(
      await deliver(
        support,
        event(runId, threadId, 2, "run.started"),
        event(runId, threadId, 5, "tool_call.completed", {
          tool_call_id: "call_new_kind",
          name: "search_tickets",
          kind: "connector",
          status: "succeeded",
          summary: "Searched tickets",
          result: { tickets: 3 },
          duration_ms: 12,
        }),
        event(runId, threadId, 6, "tool_call.completed", {
          tool_call_id: "call_new_status",
          name: "refund_order",
          kind: "app",
          status: "denied",
          summary: "Refund order was not approved",
        }),
        event(runId, threadId, 8, "message.completed", {
          message: replyWithNewThings(threadId, runId),
          citations: [],
        }),
        event(runId, threadId, 9, "run.completed", {
          output: "Here you go. Anything else?",
          usage: { credits: 1, tokens: { input: 10, output: 20 } },
          stop_reason: "end_turn",
        }),
      ),
    ).toEqual({ applied: 5, skipped: 0 });
    await h.runDue();

    // The page: a tool of a kind this version does not know is shown as a
    // Hercules tool, whose name and summary a page is not shown.
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([
      { type: "text", text: "Here you go." },
      {
        type: "tool_call",
        id: "call_new_kind",
        name: "tool",
        kind: "hercules",
        status: "succeeded",
        summary: "Used a tool",
      },
      // A call that ended with a status this version does not know is not known to have worked.
      {
        type: "tool_call",
        id: "call_new_status",
        name: "refund_order",
        kind: "app",
        status: "failed",
        summary: "Refund order was not approved",
      },
      { type: "text", text: " Anything else?" },
    ]);

    // The app's backend: the same calls under their own names.
    const details = await support.readThreadDetails(h.appCtx(), { threadId });
    expect(details?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call_new_kind",
        name: "search_tickets",
        kind: "hercules",
        status: "succeeded",
        // Only the app's own tools carry a result.
        resultJson: null,
      }),
      expect.objectContaining({
        toolCallId: "call_new_status",
        name: "refund_order",
        kind: "app",
        status: "failed",
      }),
    ]);
    expect(finished).toEqual([
      expect.objectContaining({ runId, status: "completed", usage: { credits: 1 } }),
    ]);
  });

  it("ends a capped run whose reason it does not know, and a failed one with a code it does not know", async () => {
    const support = agents();
    const first = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(
      support,
      event(first.runId, first.threadId, 9, "run.capped", {
        capped_reason: "tool_calls",
        output: "So far.",
        usage: { credits: 2 },
      }),
    );
    await h.runDue();
    let thread = await read(support, first.threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({ status: "capped", cappedReason: null, error: null });

    const second = await support.send(h.appCtx(ALICE), { threadId: first.threadId, text: "More" });
    await h.runDue();
    await deliver(
      support,
      event(second.runId, second.threadId, 9, "run.failed", {
        error: {
          code: "model_overloaded",
          message: "The model is overloaded.",
          details: { region: "x" },
        },
        usage: null,
      }),
    );
    await h.runDue();
    thread = await read(support, first.threadId);
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: { code: "model_overloaded", message: "The model is overloaded." },
    });
    expect(finished).toEqual([
      expect.objectContaining({ status: "capped", cappedReason: null, output: "So far." }),
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "model_overloaded" }),
      }),
    ]);
  });

  it("ends a run on an event of a type it does not know that Hercules marks as final", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(
      support,
      event(runId, threadId, 2, "run.started"),
      // Not marked: an event like any other.
      event(runId, threadId, 3, "run.paused", { reason: "approval" }),
    );
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await deliver(support, {
      ...event(runId, threadId, 9, "run.expired", { output: "So far.", usage: { credits: 1 } }),
      final: true,
    });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: expect.stringContaining('"run.expired"') },
    });
    expect(finished).toEqual([
      expect.objectContaining({
        runId,
        status: "failed",
        output: "So far.",
        usage: { credits: 1 },
      }),
    ]);
    // The thread is free.
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });

  it("skips a known event whose data is not the shape it knows, and cuts text it stores on the run", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(
      await deliver(
        support,
        // A message from a role added later.
        event(runId, threadId, 2, "message.completed", {
          message: { id: "m_sys", thread_id: threadId, run_id: runId, role: "tool", parts: [] },
        }),
        event(runId, threadId, 3, "message.appended", { message_id: 7, text: ["not", "text"] }),
        event(runId, threadId, 4, "tool_call.completed", { tool_call_id: "c", kind: 3 }),
        event(runId, threadId, 5, "page_action", { name: null }),
        event(runId, threadId, 6, "run.progress", { label: "x".repeat(10_000) }),
        { ...event(runId, threadId, 7, "run.started"), data: "not an object" },
      ),
    ).toEqual({ applied: 6, skipped: 0 });
    const thread = await read(support, threadId);
    expect(thread.messages).toHaveLength(1);
    expect(thread.activeRun).toMatchObject({ lastSeq: 7, status: "running" });
    expect(thread.activeRun?.progress).toHaveLength(4000);
    expect(h.db.all("tool_calls")).toEqual([]);
  });

  it("takes a start answered with fields it does not know, on the run and on its live stream", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request)
        ? Response.json(
            {
              run: {
                id: request.body.run_id,
                thread_id: request.body.thread_id,
                status: "queued",
                // Fields added later.
                priority: "high",
                required_action: null,
                capped_reason: "tool_calls",
                usage: { credits: 0, tokens: {} },
              },
              live: {
                url: `${API_URL}/v1/agents/runs/x/events`,
                token: "run-token",
                expires_at: "2026-11-15T13:00:00.000Z",
                transports: ["sse", "websocket"],
              },
              warnings: [{ code: "deprecated_field" }],
            },
            { status: 202 },
          )
        : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(h.failedActions).toEqual([]);
    expect((await read(support, threadId)).activeRun).toMatchObject({
      id: runId,
      status: "queued",
      live: { url: `${API_URL}/v1/agents/runs/x/events`, token: "run-token" },
    });
  });

  it("fails a run Hercules refuses with a code it does not know, with that code and Hercules's words", async () => {
    const support = agents();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    api.answerWith((request) =>
      isStart(request)
        ? new Response(
            JSON.stringify({
              type: "about:blank",
              status: 422,
              code: "agent_paused",
              detail: "The agent is paused.",
              // Fields of the problem this version does not know.
              docs_url: "https://example.test/docs",
              details: { until: "tomorrow" },
            }),
            { status: 422, headers: { "content-type": "application/problem+json" } },
          )
        : undefined,
    );
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    errors.mockRestore();
    // Sent once: a refusal is not sent again.
    expect(api.requests.filter(isStart)).toHaveLength(1);
    expect((await read(support, threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "agent_paused", message: "The agent is paused." },
    });
    expect(finished).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "agent_paused" }),
      }),
    ]);
  });

  it("reads what delivery missed from a page of events with entries and keys it does not know", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) => {
      if (request.path.startsWith(`/v1/agents/runs/${runId}/events`)) {
        return Response.json({
          object: "list",
          next_cursor: "abc",
          data: [
            event(runId, threadId, 2, "run.started"),
            event(runId, threadId, 3, "reasoning.completed", { summary: "Thought." }),
            null,
            event(runId, threadId, 8, "message.completed", {
              message: replyWithNewThings(threadId, runId),
            }),
            event(runId, threadId, 9, "run.completed", { output: "Here you go." }),
          ],
          has_more: false,
        });
      }
      if (request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({ id: runId, status: "completed", output: "Here you go.", tier: 2 });
      }
      return undefined;
    });
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(h.failedActions).toEqual([]);
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool_call",
      "tool_call",
      "text",
    ]);
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
  /** An agent whose runs may open an order on the page. */
  const pageAgent = () => agents({ pageActions: ["open_order"] });

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
    const support = pageAgent();
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
    const support = pageAgent();
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

  it("keeps the oldest waiting page actions listed when more than twenty arrive", async () => {
    const support = pageAgent();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my orders" });
    const calls = Array.from({ length: 25 }, (_, n) => `call_${String(n).padStart(2, "0")}`);
    await deliver(
      support,
      ...calls.map((id, n) =>
        event(runId, threadId, 5 + n, "page_action", {
          tool_call_id: id,
          name: "open_order",
          arguments: { n },
        }),
      ),
    );
    const listed = async () =>
      (await read(support, threadId)).pageActions.map((action) => action.toolCallId);
    // Oldest first: the ones that have waited longest are not the ones left out.
    expect(await listed()).toEqual(calls.slice(0, 20));
    // A tab runs the first twenty. The cap counts only what is still waiting,
    // so the last five come up, where they used to be dropped for good.
    for (const toolCallId of calls.slice(0, 20)) {
      expect(await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId })).toBe(
        true,
      );
    }
    expect(await listed()).toEqual(calls.slice(20));
  });

  it("keeps each run's tool calls apart when two runs use the same id", async () => {
    const support = pageAgent();
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

  it("lists a page action no tab took in two minutes as expired, and refuses its claim", async () => {
    const support = pageAgent();
    const { threadId, runId } = await withPageAction(support);
    // Each call here runs the query anew. A page that is subscribed to the
    // thread is not told as time passes: it sees `expired` at the thread's
    // next update, which the refused claim below causes.
    const statuses = async () =>
      (await read(support, threadId)).pageActions.map((action) => action.status);
    h.advance(2 * 60 * 1000 - 1);
    expect(await statuses()).toEqual(["pending"]);
    h.advance(1);
    expect(await statuses()).toEqual(["expired"]);
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(false);
    // The refusal is written down, so a thread that was read earlier reads again.
    expect(h.db.all("tool_calls")[0]).toMatchObject({ expired: true, claimedAt: null });
    // It stays listed for the page to say so, for ten minutes from when it arrived.
    h.advance(8 * 60 * 1000 - 1);
    expect(await statuses()).toEqual(["expired"]);
    h.advance(2);
    expect(await statuses()).toEqual([]);
  });

  it("decides a claim on the server's clock, whatever the thread said when it was read", async () => {
    const support = pageAgent();
    const { threadId, runId } = await withPageAction(support);
    // The page read the thread while the action was pending, and asks later.
    const stale = await read(support, threadId);
    expect(stale.pageActions[0]?.status).toBe("pending");
    h.advance(2 * 60 * 1000);
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(false);
    expect((await read(support, threadId)).pageActions[0]?.status).toBe("expired");
  });

  it("lists a page action that was delivered late as expired, and never runs it", async () => {
    const support = pageAgent();
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
    // The page is told, where it used to hear nothing of them.
    expect(
      (await read(support, threadId)).pageActions.map((action) => [
        action.toolCallId,
        action.name,
        action.status,
      ]),
    ).toEqual([
      ["call_late", "open_order", "expired"],
      ["call_undated", "open_order", "expired"],
    ]);
    for (const toolCallId of ["call_late", "call_undated"]) {
      expect(await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId })).toBe(
        false,
      );
    }
  });

  it("drops a page action the run was not started with, and says so in the log", async () => {
    const support = pageAgent();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Show my order" });
    await h.runDue();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const delivered = await deliver(
      support,
      event(runId, threadId, 5, "page_action", {
        tool_call_id: "call_delete",
        name: "delete_account",
        arguments: { confirm: "secret-argument" },
      }),
      // A name every object answers to is no more listed than any other.
      event(runId, threadId, 6, "page_action", {
        tool_call_id: "call_constructor",
        name: "constructor",
        arguments: {},
      }),
      event(runId, threadId, 7, "page_action", {
        tool_call_id: "call_open",
        name: "open_order",
        arguments: { orderId: "123" },
      }),
      // The record of the dropped call is kept. It is still not one a page can take.
      event(runId, threadId, 8, "tool_call.completed", {
        tool_call_id: "call_delete",
        name: "delete_account",
        kind: "page",
        status: "sent",
        summary: null,
      }),
    );
    const logged = warnings.mock.calls.map((call) => String(call[0]));
    warnings.mockRestore();
    // Each event is taken once, so a dropped one does not hold up the run's delivery.
    expect(delivered).toEqual({ applied: 4, skipped: 0 });
    expect(h.db.all("runs")[0]).toMatchObject({ lastSeq: 8 });

    expect((await read(support, threadId)).pageActions.map((action) => action.name)).toEqual([
      "open_order",
    ]);
    for (const toolCallId of ["call_delete", "call_constructor"]) {
      expect(await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId })).toBe(
        false,
      );
    }
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_open" }),
    ).toBe(true);

    // The ids and the name, and nothing of the arguments.
    expect(logged).toEqual([
      expect.stringMatching(new RegExp(`"delete_account" \\(call call_delete\\) of run ${runId}`)),
      expect.stringMatching(
        new RegExp(`"constructor" \\(call call_constructor\\) of run ${runId}`),
      ),
    ]);
    expect(logged.join()).not.toContain("secret-argument");
  });

  it("checks a page action against its own run's list, not the agent's", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    // This run was started with a list of its own.
    const support = pageAgent();
    const own = await support.send(h.appCtx(ALICE), {
      text: "Show my invoice",
      pageActions: ["show_invoice"],
    });
    // And an agent with no page actions starts runs that may send none.
    const plain = agents();
    const none = await plain.send(h.appCtx(ALICE), { text: "Show my order" });
    await h.runDue();
    for (const { threadId, runId } of [own, none]) {
      await deliver(
        support,
        event(runId, threadId, 5, "page_action", {
          tool_call_id: "call_open",
          name: "open_order",
          arguments: { orderId: "123" },
        }),
        event(runId, threadId, 6, "page_action", {
          tool_call_id: "call_invoice",
          name: "show_invoice",
          arguments: { invoiceId: "456" },
        }),
      );
    }
    warnings.mockRestore();
    expect((await read(support, own.threadId)).pageActions.map((action) => action.name)).toEqual([
      "show_invoice",
    ]);
    expect((await read(plain, none.threadId)).pageActions).toEqual([]);
    expect(h.db.all("tool_calls").map((row) => row["name"])).toEqual(["show_invoice"]);
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
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      `POST /v1/agents/runs/${runId}/cancel`,
    );
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    // The delivered ending changes nothing.
    await deliver(support, event(runId, threadId, 9, "run.cancelled", { usage: { credits: 0.5 } }));
    await h.runDue();
    expect(finished).toHaveLength(1);
  });

  it("says the run is stopping until Hercules has stopped it, and asks again soon", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect((await read(support, threadId)).activeRun?.stopping).toBe(false);
    let cancels = 0;
    api.answerWith((request) => {
      if (request.path !== `/v1/agents/runs/${runId}/cancel`) return undefined;
      // The run had not ended yet when Hercules answered the first stop.
      return ++cancels === 1 ? Response.json({ id: runId, status: "running" }) : undefined;
    });
    await support.cancel(h.appCtx(ALICE), { threadId });
    expect((await read(support, threadId)).activeRun).toMatchObject({ id: runId, stopping: true });
    await h.runDue();
    // Still going, so a new message is refused, and the page can say why.
    expect((await read(support, threadId)).activeRun?.stopping).toBe(true);
    await expect(support.send(h.appCtx(ALICE), { threadId, text: "Next" })).rejects.toSatisfy(
      (error) => errorCode(error) === "thread_busy",
    );
    // Asked again within a second, not at the stuck-run check three minutes on.
    await h.runUntil(h.now + 1000);
    expect(cancels).toBe(2);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });

  it("reads what the run wrote before it records the stop", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Delivery is behind, or down: the checkpoint is only at Hercules.
    api.answerWith((request) =>
      request.path.startsWith(`/v1/agents/runs/${runId}/events`)
        ? Response.json({
            data: [
              event(runId, threadId, 2, "run.started"),
              event(runId, threadId, 3, "message.appended", {
                message_id: "msg_1",
                text: "Here is the first part",
              }),
              event(runId, threadId, 4, "run.cancelled", { usage: { credits: 0.5 } }),
            ],
            has_more: false,
          })
        : undefined,
    );
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("cancelled");
    expect(thread.messages[1]).toMatchObject({
      id: "msg_1",
      status: "incomplete",
      parts: [{ type: "text", text: "Here is the first part" }],
    });
    expect(finished).toHaveLength(1);
  });

  it("records the stop even when what the run wrote cannot be read", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      request.path.startsWith(`/v1/agents/runs/${runId}/events`)
        ? new Response("down", { status: 503 })
        : undefined,
    );
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
  });

  it("keeps a checkpoint delivered after the stop as an incomplete reply", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    expect((await read(support, threadId)).latestRun?.status).toBe("cancelled");
    // The answer to the cancel came first: delivery brings the reply's text after it.
    await deliver(
      support,
      event(runId, threadId, 3, "message.appended", { message_id: "msg_1", text: "Here is " }),
      event(runId, threadId, 5, "message.appended", {
        message_id: "msg_1",
        text: "the first part",
      }),
      event(runId, threadId, 6, "run.cancelled", { usage: { credits: 0.5 } }),
    );
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    // Nothing is still writing it, so it does not read as `streaming`.
    expect(thread.messages[1]).toMatchObject({
      id: "msg_1",
      status: "incomplete",
      parts: [{ type: "text", text: "Here is the first part" }],
    });
    expect(finished).toHaveLength(1);
  });

  it("records a stopped run that Hercules ends as failed as cancelled", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Hercules ends a run stopped in its first step as failed, with no code of its own.
    api.answerWith((request) =>
      request.path === `/v1/agents/runs/${runId}/cancel`
        ? Response.json({
            id: runId,
            status: "failed",
            error: { code: "run_failed", message: "The run failed before it finished." },
            usage: { credits: 0 },
          })
        : undefined,
    );
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    const thread = await read(support, threadId);
    expect(thread.latestRun).toMatchObject({ status: "cancelled", error: null });
    expect(finished).toEqual([expect.objectContaining({ status: "cancelled", error: null })]);
  });

  it("keeps a failure with a code of its own, stop or no stop", async () => {
    const support = agents();
    const first = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      request.path.endsWith("/cancel") ? Response.json({ id: "x", status: "running" }) : undefined,
    );
    await support.cancel(h.appCtx(ALICE), { threadId: first.threadId });
    await deliver(
      support,
      event(first.runId, first.threadId, 3, "run.failed", {
        error: { code: "out_of_credits", message: "The organization is out of credits." },
        usage: null,
      }),
    );
    expect((await read(support, first.threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "out_of_credits" },
    });

    // And a run nobody stopped that fails with `run_failed` stays failed.
    const second = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await deliver(
      support,
      event(second.runId, second.threadId, 3, "run.failed", {
        error: { code: "run_failed", message: "The run failed before it finished." },
        usage: null,
      }),
    );
    expect((await read(support, second.threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed" },
    });
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

describe("a deleted thread's id", () => {
  const CHOSEN = "11111111-1111-4111-8111-111111111111";

  /** A thread with more rows than one purge batch deletes. */
  async function longThread(support: HerculesAgents) {
    const first = await support.send(h.appCtx(ALICE), { threadId: CHOSEN, text: "Hi" });
    await h.runDue();
    for (let batch = 0; batch < 3; batch++) {
      const chunks = [];
      for (let seq = 2 + batch * 100; seq < 102 + batch * 100; seq++) {
        chunks.push(
          event(first.runId, CHOSEN, seq, "message.appended", { message_id: "m1", text: "x" }),
        );
      }
      await deliver(support, ...chunks);
    }
    return first;
  }

  it("cannot be used again, so the purge never takes a newer conversation", async () => {
    const support = agents();
    const first = await longThread(support);
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId: CHOSEN })).toBe(true);

    // The first purge batch has run, and the rest of the old rows are still there.
    const jobs = h.takeScheduled();
    const purge = jobs.find((job) => job.name === "threads:purge")!;
    await h.call(purge.ref as never, purge.args);
    expect(h.db.all("message_chunks").length).toBeGreaterThan(0);

    // The page kept its thread id and sends again.
    const error = await support
      .send(h.appCtx(ALICE), { threadId: CHOSEN, text: "A new conversation" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("thread_deleted");
    expect((error as ConvexError<{ message: string }>).data.message).toMatch(/new id/);
    expect(h.db.all("threads")).toEqual([]);
    expect(h.db.all("runs").every((row) => row["runId"] === first.runId)).toBe(true);

    await h.runDue();
    for (const table of ["threads", "runs", "run_requests", "messages", "message_chunks"]) {
      expect(h.db.all(table)).toHaveLength(0);
    }
    // Refused for good, and for anyone: the id is retired.
    for (const who of [ALICE, BOB]) {
      const later = await support
        .send(h.appCtx(who), { threadId: CHOSEN, text: "Again" })
        .catch((e: unknown) => e);
      expect(errorCode(later)).toBe("thread_deleted");
    }
    expect(await support.readThread(h.appCtx(ALICE), { threadId: CHOSEN })).toBeNull();
  });

  it("is all a late delete at Hercules can reach", async () => {
    const support = agents();
    await support.send(h.appCtx(ALICE), { threadId: CHOSEN, text: "Hi" });
    await h.runDue();
    // Hercules cannot be reached, so its delete is retried, for minutes.
    let down = true;
    api.answerWith((request) =>
      down && request.method === "DELETE" ? new Response("down", { status: 503 }) : undefined,
    );
    await support.deleteThread(h.appCtx(ALICE), { threadId: CHOSEN });
    await h.runDue();
    expect(h.scheduled.map((job) => job.name)).toContain("hercules:deleteTick");

    // Meanwhile the user starts over. Under the old id they cannot, so the
    // delete still to come names no conversation that exists.
    const reused = await support
      .send(h.appCtx(ALICE), { threadId: CHOSEN, text: "Start over" })
      .catch((e: unknown) => e);
    expect(errorCode(reused)).toBe("thread_deleted");
    const fresh = await support.send(h.appCtx(ALICE), {
      threadId: "22222222-2222-4222-8222-222222222222",
      text: "Start over",
    });
    down = false;
    await h.runUntil(h.now + 20 * 60 * 1000);
    const deletes = api.requests.filter((request) => request.method === "DELETE");
    expect(deletes.length).toBeGreaterThan(1);
    expect(new Set(deletes.map((request) => request.path))).toEqual(
      new Set([`/v1/agents/threads/${CHOSEN}`]),
    );
    expect((await read(support, fresh.threadId)).messages).toHaveLength(1);
  });

  it("is not taken by a thread that was never there", async () => {
    const support = agents();
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId: CHOSEN })).toBe(false);
    expect((await support.send(h.appCtx(ALICE), { threadId: CHOSEN, text: "Hi" })).threadId).toBe(
      CHOSEN,
    );
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
    // The checks come further apart by now, so the hour is up at one of the next.
    await h.runUntil(h.now + 30 * 60 * 1000);
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
    await h.runJob(next);
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
    // Not sooner than asked, and further apart each time: 1, 1, 2, 4, 8, 16, 32 seconds.
    await h.runUntil(h.now + 70_000);
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
      "hercules:startRun",
      "hercules:tickRun",
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
    // Stopped, then read for what it wrote before the stop.
    expect(api.requests.map((r) => r.path)).toEqual([
      `/v1/agents/runs/${runId}/cancel`,
      `/v1/agents/runs/${runId}/events?after=0&limit=100`,
    ]);
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

  it("answers 413 for several events, so Hercules halves the batch down to the one that fails", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Whatever the error says: no text of Convex's is read to decide.
    for (const message of ["Too many bytes written (limit: 16777216 bytes)", "something else"]) {
      const restore = failPatches(message);
      const response = await postEvents(
        support,
        event(runId, threadId, 2, "run.started"),
        event(runId, threadId, 3, "run.progress", { label: "Thinking" }),
      );
      expect(response.status).toBe(413);
      restore();
    }
    // Nothing of the batch stayed, so the smaller one applies cleanly.
    expect(await deliver(support, event(runId, threadId, 2, "run.started"))).toEqual({
      applied: 1,
      skipped: 0,
    });
    errors.mockRestore();
  });

  it("answers 500 for one event it cannot apply, which is tried again and not shelved", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const message of ["Too many bytes written (limit: 16777216 bytes)", "something else"]) {
      const restore = failPatches(message);
      const response = await postEvents(support, event(runId, threadId, 2, "run.started"));
      expect(response.status).toBe(500);
      restore();
    }
    errors.mockRestore();
  });

  it("takes event types and fields it does not know, and skips what it cannot place", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const response = await postEvents(
      support,
      // A type added to the API later, with data and envelope fields of its own.
      { ...event(runId, threadId, 2, "run.rerouted", { to: "eu" }), trace_id: "t1", attempt: 3 },
      { ...event(runId, threadId, 3, "run.started"), delivered_by: "worker-7" },
      // Nothing can be done with these: no sequence number, no run.
      { run_id: runId, thread_id: threadId, type: "run.progress", data: { label: "x" } },
      { seq: 9, type: "run.progress" },
      "not an event",
    );
    // 2xx: a refusal here would hold up the thread until the app's next deploy.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 2, skipped: 3 });
    expect((await read(support, threadId)).activeRun).toMatchObject({
      status: "running",
      lastSeq: 3,
    });
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
    expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:tickRun"]);
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
    // The check died. The tick that started it is a mutation, and comes back.
    expect(h.failedActions.map((failure) => failure.name)).toEqual(["hercules:checkRun"]);
    expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:tickRun"]);
    db.patch = patch;
    await h.runUntil(h.now + 3 * 60 * 1000);
    errors.mockRestore();
    expect((await read(support, threadId)).latestRun?.status).toBe("completed");
  });
});

/** A run at Hercules whose state the test changes while the component reads it. */
function herculesRun(runId: string, threadId: string) {
  const state = {
    status: "running",
    output: null as string | null,
    /** When Hercules says the run ended. Null while it is going. */
    finishedAt: null as string | null,
    events: [] as ReturnType<typeof event>[],
    /** What was read, in order. */
    reads: [] as string[],
    /** Called before each read is answered: where the run moves on between two reads. */
    beforeRead: (_reads: number) => {},
    /** The reply, its message and the run's ending: the run is over. */
    complete() {
      state.status = "completed";
      state.output = "Done.";
      state.events = [
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
    },
  };
  api.answerWith((request) => {
    if (request.method !== "GET" || !request.path.startsWith(`/v1/agents/runs/${runId}`)) {
      return undefined;
    }
    state.beforeRead(state.reads.length);
    if (request.path.includes("/events")) {
      state.reads.push("events");
      const after = Number(/after=(\d+)/.exec(request.path)?.[1] ?? 0);
      return Response.json({
        data: state.events.filter((entry) => entry.seq > after),
        has_more: false,
      });
    }
    state.reads.push("run");
    return Response.json({
      id: runId,
      thread_id: threadId,
      status: state.status,
      output: state.output,
      finished_at: state.finishedAt,
    });
  });
  return state;
}

describe("the stuck-run check, against a run that moves on while it is read", () => {
  it("reads the run, then its events, so a reply written between the two is not missed", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    // The run finishes at Hercules between the check's first read and its second.
    run.beforeRead = (reads) => {
      if (reads === 1) run.complete();
    };
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(run.reads).toEqual(["run", "events"]);
    const thread = await read(support, threadId);
    // Read the other way round, the check saw no events, then a finished run,
    // and ended the run without its reply.
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
    expect(finished).toEqual([expect.objectContaining({ runId, output: "Done." })]);
  });

  it("settles at the next tick a run that finishes just after it was read", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    // Still going at both reads of the first check, over right after.
    run.beforeRead = (reads) => {
      if (reads === 2) run.complete();
    };
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await h.runUntil(h.now + 3 * 60 * 1000);
    expect(run.reads).toEqual(["run", "events", "run", "events"]);
    const thread = await read(support, threadId);
    expect(thread.latestRun?.status).toBe("completed");
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
  });

  it("is started again by the next tick when a check is lost", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    run.complete();
    // Convex runs a scheduled action at most once. The check the first tick
    // started never ran; the tick is a mutation, and those are not lost.
    await runOnly((name) => name !== "hercules:checkRun", h.now + 3 * 60 * 1000);
    expect(run.reads).toEqual([]);
    expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:tickRun"]);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);

    await h.runUntil(h.now + 3 * 60 * 1000);
    expect((await read(support, threadId)).latestRun?.status).toBe("completed");
    // The tick ends with the run.
    await h.runUntil(h.now + 60 * 60 * 1000 + 1);
    expect(h.scheduled).toEqual([]);
  });

  it("ends a run by itself when no check could settle it in a day", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const sentAt = h.now;
    // Every check is lost, for a day.
    await runOnly((name) => name !== "hercules:checkRun", sentAt + 24 * 60 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await runOnly((name) => name !== "hercules:checkRun", sentAt + 24.6 * 60 * 60 * 1000);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: "The run could not be settled within a day." },
    });
    // Hercules may still have the run going, and would hold the thread: it is asked to stop it.
    await h.runDue();
    expect(api.requests.map((request) => request.path)).toContain(
      `/v1/agents/runs/${runId}/cancel`,
    );
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });

  it("looks at a run Hercules says is still going less and less often", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const sentAt = h.now;
    const run = herculesRun(runId, threadId);
    const minutes: number[] = [];
    run.beforeRead = () => {
      const at = Math.round((h.now - sentAt) / 60_000);
      if (minutes.at(-1) !== at) minutes.push(at);
    };
    // An accepted run with nothing delivered, for an hour and a half.
    await h.runUntil(sentAt + 90 * 60 * 1000);
    // It was every three minutes: 30 checks and 60 reads in this time.
    expect(minutes).toEqual([3, 6, 12, 24, 48, 78]);
    expect(run.reads).toHaveLength(12);

    // Anything delivered, and the waits start over. The tick that was already
    // scheduled comes at its time (minute 108), and from there it is three
    // minutes, six, twelve again.
    await deliver(support, event(runId, threadId, 2, "run.started"));
    expect(h.db.all("runs")[0]).toMatchObject({ quietChecks: 0 });
    minutes.length = 0;
    await h.runUntil(sentAt + 130 * 60 * 1000);
    expect(minutes).toEqual([108, 111, 117, 129]);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
  });

  it("gives up on a run whose answers from Hercules cannot be read for a day, and asks to stop it", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const sentAt = h.now;
    // Hercules answers for the run, with nothing that reads as a run.
    api.answerWith((request) =>
      request.method === "GET" && request.path === `/v1/agents/runs/${runId}`
        ? Response.json({ unexpected: true })
        : undefined,
    );
    await h.runUntil(sentAt + 24 * 60 * 60 * 1000 + 31 * 60 * 1000, 2000);
    const thread = await read(support, threadId);
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: {
        code: "run_failed",
        message: "What Hercules answered about this run could not be read for a day.",
      },
    });
    // The thread is free here. Left going at Hercules, the run would hold it
    // there, and the next message would be refused as `thread_busy`.
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      `POST /v1/agents/runs/${runId}/cancel`,
    );
  });

  it("asks Hercules to stop a run again when the call that carried the cancel gave up", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    let cancels = 0;
    api.answerWith((request) => {
      if (request.path !== `/v1/agents/runs/${runId}/cancel`) return undefined;
      // Down for every try the cancel call makes, and back after.
      return ++cancels <= 6 ? new Response("down", { status: 503 }) : undefined;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 60 * 1000);
    expect(cancels).toBe(6);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await h.runUntil(h.now + 3 * 60 * 1000);
    errors.mockRestore();
    expect(cancels).toBe(7);
    expect((await read(support, threadId)).latestRun?.status).toBe("cancelled");
  });
});

describe("a run status this version does not know", () => {
  const DAY = 24 * 60 * 60 * 1000;
  // A run that is paused, waiting for a person: a status the API may add.
  const WAITING = "requires_action";
  const requested = (from = 0) =>
    api.requests.slice(from).map((request) => `${request.method} ${request.path}`);

  it("is final only for the four statuses a run ends with", () => {
    for (const status of ["completed", "failed", "cancelled", "capped"]) {
      expect(isFinalStatus(status)).toBe(true);
    }
    for (const status of ["queued", "running", WAITING, "interrupted", "", "Completed"]) {
      expect(isFinalStatus(status)).toBe(false);
    }
    // A run is over in a status this version does not know only when Hercules
    // says when it finished. One it knows as going is going.
    const run = (status: string, finishedAt: string | null) =>
      hasRunEnded(readRun({ id: "r", status, finished_at: finishedAt })!);
    expect(run(WAITING, null)).toBe(false);
    expect(run("expired", "2026-11-15T12:00:09.000Z")).toBe(true);
    expect(run("running", "2026-11-15T12:00:09.000Z")).toBe(false);
    expect(run("queued", "2026-11-15T12:00:09.000Z")).toBe(false);
    expect(run("completed", null)).toBe(true);
  });

  it("is a run that is going, when the start is answered with it", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request)
        ? Response.json(
            {
              run: { id: request.body.run_id, thread_id: request.body.thread_id, status: WAITING },
              live: { url: `${API_URL}/v1/agents/runs/x/events`, token: "run-token" },
            },
            { status: 202 },
          )
        : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Hercules took the run, and its stream is there to read.
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: true, status: "running" });
    const thread = await read(support, threadId);
    expect(thread.activeRun).toMatchObject({
      id: runId,
      status: "running",
      live: { token: "run-token" },
      stopping: false,
    });
    expect(thread.latestRun).toMatchObject({ id: runId, status: "running", error: null });
    expect(finished).toEqual([]);
    // The thread is busy, as behind any run that is going.
    const busy = await support
      .send(h.appCtx(ALICE), { threadId, text: "Again" })
      .catch((e: unknown) => e);
    expect(errorCode(busy)).toBe("thread_busy");
  });

  it.each([["running"], [WAITING]])(
    "keeps a run open for as long as Hercules says it is %s, and checks it every half hour at most",
    async (status) => {
      const support = agents();
      const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
      await h.runDue();
      const sentAt = h.now;
      const run = herculesRun(runId, threadId);
      run.status = status;
      await h.runUntil(sentAt + 2 * DAY, 4000);
      const readsAfterTwoDays = run.reads.length;
      await h.runUntil(sentAt + 3 * DAY, 4000);
      // Not settled, not failed, and not asked to stop: Hercules has it going.
      const thread = await read(support, threadId);
      expect(thread.activeRun).toMatchObject({ id: runId, status: "running" });
      expect(thread.latestRun).toMatchObject({ status: "running", error: null });
      expect(finished).toEqual([]);
      expect(requested().filter((line) => line.endsWith("/cancel"))).toEqual([]);
      // A bounded pace: one read of the run and one of its events per half hour.
      expect(run.reads.length - readsAfterTwoDays).toBe(2 * 48);
      expect(h.scheduled.map((job) => job.name)).toEqual(["hercules:tickRun"]);

      // When it does end, it is settled as it ended, with its reply.
      run.complete();
      await h.runUntil(h.now + 31 * 60 * 1000);
      const settled = await read(support, threadId);
      expect(settled.activeRun).toBeNull();
      expect(settled.latestRun?.status).toBe("completed");
      expect(settled.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
      expect(finished).toEqual([expect.objectContaining({ runId, status: "completed" })]);
    },
  );

  it("still gives up on a run nothing was heard of for a day, counted from when it last was", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const sentAt = h.now;
    const run = herculesRun(runId, threadId);
    run.status = WAITING;
    await h.runUntil(sentAt + 2 * DAY, 4000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    // From here Hercules cannot be reached at all.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    api.answerWith(() => new Response("down", { status: 503 }));
    const silentFrom = h.now;
    await h.runUntil(silentFrom + 23 * 60 * 60 * 1000, 4000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await h.runUntil(silentFrom + DAY + 61 * 60 * 1000, 4000);
    errors.mockRestore();
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({ status: "failed", error: { code: "run_failed" } });
  });

  it("can be stopped: the stop is sent, and the run ends as Hercules ended it", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    run.status = WAITING;
    await h.runUntil(h.now + 2 * DAY, 4000);
    const before = api.requests.length;
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(true);
    expect((await read(support, threadId)).activeRun).toMatchObject({ id: runId, stopping: true });
    await h.runDue();
    expect(requested(before)).toContain(`POST /v1/agents/runs/${runId}/cancel`);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    expect(finished).toEqual([expect.objectContaining({ runId, status: "cancelled" })]);
  });

  it("frees the thread of an old run that was asked to stop and that Hercules keeps going", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    run.status = WAITING;
    await h.runUntil(h.now + 2 * DAY, 4000);
    // Hercules takes the stop and goes on answering that the run waits.
    api.answerWith((request) =>
      request.path.startsWith(`/v1/agents/runs/${runId}`) && !request.path.includes("/events")
        ? Response.json({ id: runId, thread_id: threadId, status: WAITING, finished_at: null })
        : undefined,
    );
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runUntil(h.now + 31 * 60 * 1000, 400);
    const thread = await read(support, threadId);
    // The user stopped it, so that is what it reads as, and a message can be sent.
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({ status: "cancelled", error: null });
    await support.send(h.appCtx(ALICE), { threadId, text: "Next" });
  });

  it("is an ending when Hercules says the run finished, recorded as failed with what it wrote", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    run.complete();
    // An ending added after this version was built.
    run.status = "expired";
    run.finishedAt = "2026-11-15T12:00:09.000Z";
    run.events[2] = event(runId, threadId, 9, "run.expired", { output: "Done." });
    await h.runUntil(h.now + 3 * 60 * 1000);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toMatchObject({
      status: "failed",
      error: {
        code: "run_failed",
        message: expect.stringContaining('the status "expired"'),
      },
    });
    // The reply the run wrote is kept.
    expect(thread.messages[1]?.parts).toEqual([{ type: "text", text: "Done." }]);
    expect(finished).toEqual([
      expect.objectContaining({ runId, status: "failed", output: "Done." }),
    ]);
    await h.runUntil(h.now + 61 * 60 * 1000);
    expect(h.scheduled).toEqual([]);
  });

  it("leaves a run going when an event of a type it does not know is delivered, final or not", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    const run = herculesRun(runId, threadId);
    expect(
      await deliver(
        support,
        event(runId, threadId, 2, "run.started"),
        event(runId, threadId, 3, "run.requires_action", { action: { type: "approval" } }),
      ),
    ).toEqual({ applied: 2, skipped: 0 });
    await h.runDue();
    let thread = await read(support, threadId);
    expect(thread.activeRun).toMatchObject({ id: runId, status: "running", lastSeq: 3 });
    expect(finished).toEqual([]);

    // A final event of a type added later cannot be told from any other by
    // its name. The run stays open until the check reads how it stands.
    await deliver(support, event(runId, threadId, 9, "run.expired", { output: null }));
    thread = await read(support, threadId);
    expect(thread.activeRun?.id).toBe(runId);
    expect(finished).toEqual([]);
    run.status = "cancelled";
    await h.runUntil(h.now + 3 * 60 * 1000);
    thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.status).toBe("cancelled");
    expect(finished).toEqual([expect.objectContaining({ runId, status: "cancelled" })]);
  });

  it("does not stop a deleted thread from being deleted at Hercules", async () => {
    const support = agents();
    // The start is never answered, so the delete asks for the run first.
    api.answerWith((request) => {
      if (isStart(request)) return new Response("down", { status: 503 });
      const runRead = /^\/v1\/agents\/runs\/([^/]+)$/.exec(request.path);
      if (request.method === "GET" && runRead !== null) {
        return Response.json({ id: runRead[1], thread_id: threadId, status: WAITING });
      }
      return undefined;
    });
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 60_000);
    expect(requested()).toContain(`DELETE /v1/agents/threads/${threadId}`);
    expect(h.db.all("deleted_threads")[0]).toMatchObject({
      remoteDeletedAt: expect.any(Number),
      remoteGaveUpAt: null,
    });
  });
});

describe("a start Hercules refuses", () => {
  it("fails with run_id_conflict, once, when Hercules has the id with another body", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request)
        ? problem(409, "run_id_conflict", "A run with this id was started with another body.")
        : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    errors.mockRestore();
    expect(api.requests.filter(isStart)).toHaveLength(1);
    expect((await read(support, threadId)).latestRun?.error).toEqual({
      code: "run_id_conflict",
      message: "A run with this id was started with another body.",
    });
  });

  it("reads a 404 as the app being set up wrong, not as a thread that is gone", async () => {
    const support = agents();
    // Hercules does not know the agent, or the agents API is off for the app.
    api.answerWith((request) =>
      isStart(request) ? problem(404, "not_found", "Not found.") : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 60_000);
    errors.mockRestore();
    expect(api.requests.filter(isStart)).toHaveLength(1);
    const error = (await read(support, threadId)).latestRun?.error;
    expect(error?.code).toBe("agent_not_found");
    expect(error?.message).toMatch(/agent id/);
  });

  it("fails with hercules_auth_required, once, in words for the developer and others for the page", async () => {
    const support = agents();
    // The app has no Hercules Auth 2.0 tenant: Hercules could not sign what it sends the app.
    api.answerWith((request) =>
      isStart(request)
        ? problem(409, "hercules_auth_required", "The app has no Hercules Auth tenant.")
        : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    // Never sent again: not by the start call, and not by the stuck-run check.
    await h.runUntil(h.now + 10 * 60_000);
    const logged = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();
    expect(api.requests.filter(isStart)).toHaveLength(1);

    // The run's own error, the log, and `onRunFinished` are the developer's.
    const upgrade = /Upgrade the app to Hercules Auth 2\.0/;
    const stored = (await support.readThreadDetails(h.appCtx(), { threadId }))?.latestRun;
    expect(stored).toMatchObject({ id: runId, status: "failed" });
    expect(stored?.error).toEqual({
      code: "hercules_auth_required",
      message: expect.stringMatching(upgrade),
    });
    expect(logged.filter((line) => upgrade.test(line))).toEqual([
      expect.stringContaining(`Hercules refused run ${runId}: 409 hercules_auth_required`),
    ]);
    expect(finished).toEqual([
      expect.objectContaining({ runId, status: "failed", error: stored?.error }),
    ]);

    // The page's thread has the code, and words for its user.
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun).toEqual({
      id: runId,
      status: "failed",
      error: {
        code: "hercules_auth_required",
        message: "The assistant is not available right now.",
      },
      cappedReason: null,
      finished_at: expect.any(String),
    });
  });

  it.each([[426], [400], [503]])(
    "fails with client_upgrade_required (%i), once, telling the developer to upgrade the package",
    async (status) => {
      const support = agents();
      // Reserved: Hercules no longer takes this version of the package.
      api.answerWith((request) =>
        isStart(request)
          ? problem(status, "client_upgrade_required", "Versions before 0.9.0 are retired.")
          : undefined,
      );
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
      // Never sent again: not by the start call, and not by the stuck-run check.
      await h.runUntil(h.now + 10 * 60_000);
      const logged = errors.mock.calls.map((call) => String(call[0]));
      errors.mockRestore();
      expect(api.requests.filter(isStart)).toHaveLength(1);
      expect(h.scheduled.map((job) => job.name)).not.toContain("hercules:tickRun");

      // The run's own error, the log, and `onRunFinished` are the developer's.
      const upgrade = /this version of @usehercules\/agents\. Upgrade the package/;
      const stored = (await support.readThreadDetails(h.appCtx(), { threadId }))?.latestRun;
      expect(stored).toMatchObject({ id: runId, status: "failed" });
      expect(stored?.error).toEqual({
        code: "client_upgrade_required",
        message: expect.stringMatching(upgrade),
      });
      // With what Hercules said about it.
      expect(stored?.error?.message).toContain("Versions before 0.9.0 are retired.");
      expect(logged.filter((line) => upgrade.test(line))).toEqual([
        expect.stringContaining(`Hercules refused run ${runId}: ${status} client_upgrade_required`),
      ]);
      expect(finished).toEqual([
        expect.objectContaining({ runId, status: "failed", error: stored?.error }),
      ]);

      // The page's thread has the code, and the words of any failure that is the app's setup.
      const thread = await read(support, threadId);
      expect(thread.activeRun).toBeNull();
      expect(thread.latestRun?.error).toEqual({
        code: "client_upgrade_required",
        message: "The assistant is not available right now.",
      });
    },
  );

  it("ends a run going when Hercules answers its read with client_upgrade_required, and does not ask again", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // The run was taken. From here Hercules no longer takes this version.
    api.answerWith(() => problem(426, "client_upgrade_required", "Upgrade Required"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runUntil(h.now + 3 * 60 * 1000);
    const asked = api.requests.length;
    await h.runUntil(h.now + 2 * 60 * 60 * 1000);
    errors.mockRestore();
    expect(api.requests).toHaveLength(asked);
    expect(h.scheduled.map((job) => job.name)).not.toContain("hercules:tickRun");
    const stored = (await support.readThreadDetails(h.appCtx(), { threadId }))?.latestRun;
    expect(stored).toMatchObject({
      id: runId,
      status: "failed",
      error: {
        code: "client_upgrade_required",
        message: expect.stringMatching(/Upgrade the package to its latest version/),
      },
    });
    expect((await read(support, threadId)).latestRun?.error?.message).toBe(
      "The assistant is not available right now.",
    );
    expect(finished).toHaveLength(1);
  });

  it("stops asking Hercules to delete a thread once it answers client_upgrade_required", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(
      support,
      event(h.db.all("runs")[0]!["runId"] as string, threadId, 9, "run.completed", {}),
    );
    await h.runDue();
    api.answerWith((request) =>
      request.method === "DELETE"
        ? problem(426, "client_upgrade_required", "Upgrade Required")
        : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 2 * 60 * 60 * 1000);
    errors.mockRestore();
    expect(api.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(h.db.all("deleted_threads")[0]).toMatchObject({
      remoteDeletedAt: null,
      remoteGaveUpAt: expect.any(Number),
      purgedAt: expect.any(Number),
    });
  });

  it.each([
    [409, "a_refusal_from_the_future", "Something this version has no name for.", undefined],
    [429, "a_limit_from_the_future", "A limit this version has no name for.", 90],
  ])(
    "fails with a code it does not know as Hercules sent it: %i %s",
    async (status, code, detail, wait) => {
      const support = agents();
      api.answerWith((request) =>
        isStart(request) ? problem(status, code, detail, wait) : undefined,
      );
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
      await h.runUntil(h.now + 60_000);
      errors.mockRestore();
      expect(api.requests.filter(isStart)).toHaveLength(1);
      const error = {
        code,
        message: detail,
        ...(wait !== undefined && { retryAfterSeconds: wait }),
      };
      // The page and the backend read the same: the message is Hercules's own.
      expect((await read(support, threadId)).latestRun?.error).toStrictEqual(error);
      const details = await support.readThreadDetails(h.appCtx(), { threadId });
      expect(details?.latestRun?.error).toStrictEqual(error);
      expect(finished).toEqual([expect.objectContaining({ runId, status: "failed", error })]);
    },
  );

  /** "Start unconfirmed": Hercules has the run, and cannot say yet that it started. */
  function unconfirmed(runId: unknown) {
    return new Response(
      JSON.stringify({
        code: "service_unavailable",
        detail: "The run was not confirmed to have started.",
        details: { run_id: runId },
      }),
      { status: 503, headers: { "retry-after": "2", "content-type": "application/problem+json" } },
    );
  }

  it("keeps a run open through a minute of 503s that say Hercules has it, then takes its reply", async () => {
    const support = agents();
    let down = true;
    api.answerWith((request) =>
      isStart(request) && down ? unconfirmed(request.body.run_id) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await h.runUntil(sentAt + 60_000);

    // It used to give up after eight tries, about 14 seconds in: the run
    // failed here, `onRunFinished` said so, and the thread was free for a
    // message Hercules would refuse as `thread_busy`.
    const starts = api.requests.filter(isStart);
    expect(starts.length).toBeGreaterThan(5);
    expect(new Set(starts.map((request) => JSON.stringify(request.body))).size).toBe(1);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toMatchObject({ id: runId, live: null });
    expect(thread.latestRun).toMatchObject({ id: runId, error: null });
    expect(finished).toEqual([]);
    // Hercules said it has the run: it is its run now.
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: true });
    const jobs = h.scheduled.map((job) => job.name);
    expect(jobs).toContain("hercules:tickRun");
    const busy = await support
      .send(h.appCtx(ALICE), { threadId, text: "Still there?" })
      .catch((e: unknown) => e);
    expect(errorCode(busy)).toBe("thread_busy");

    // The run was going at Hercules all along, and its events are delivered.
    await deliver(
      support,
      event(runId, threadId, 1, "run.queued"),
      event(runId, threadId, 2, "run.started"),
      event(runId, threadId, 8, "message.completed", {
        message: {
          id: "msg_1",
          thread_id: threadId,
          run_id: runId,
          role: "assistant",
          parts: [{ type: "text", text: "Here you go." }],
          created_at: "2026-11-15T12:00:01.000Z",
        },
      }),
      event(runId, threadId, 9, "run.completed", { output: "Here you go.", usage: { credits: 1 } }),
    );
    const settled = await read(support, threadId);
    expect(settled.latestRun).toMatchObject({ id: runId, status: "completed", error: null });
    expect(settled.messages[1]?.parts).toEqual([{ type: "text", text: "Here you go." }]);
    await h.runDue();
    expect(finished).toEqual([expect.objectContaining({ runId, status: "completed" })]);
    // The start call sees the run is over and stops asking.
    const before = api.requests.filter(isStart).length;
    await h.runUntil(h.now + 10 * 60 * 1000);
    expect(api.requests.filter(isStart)).toHaveLength(before);
  });

  it("takes the live token when a retry of an unconfirmed start is answered", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls <= 3 ? unconfirmed(request.body.run_id) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    // Not sooner than the two seconds Hercules asked for.
    await h.runUntil(sentAt + 1_999);
    expect(calls).toBe(1);
    await h.runUntil(sentAt + 30_000);
    expect(calls).toBe(4);
    expect((await read(support, threadId)).activeRun?.live?.token).toBe(`token-${runId}`);
  });

  it("settles an unconfirmed run Hercules's reaper ended, with the reaper's ending", async () => {
    const support = agents();
    let runId = "";
    api.answerWith((request) => {
      if (isStart(request)) return unconfirmed(request.body.run_id);
      // It never started, and Hercules ended it after two minutes.
      if (request.method === "GET" && request.path === `/v1/agents/runs/${runId}`) {
        return Response.json({
          id: runId,
          status: "failed",
          error: { code: "run_failed", message: "The run did not start." },
        });
      }
      return undefined;
    });
    const sent = await support.send(h.appCtx(ALICE), { text: "Hi" });
    runId = sent.runId;
    await h.runUntil(h.now + 4 * 60 * 1000);
    const thread = await read(support, sent.threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.error).toEqual({
      code: "run_failed",
      message: "The run did not start.",
    });
    await support.send(h.appCtx(ALICE), { threadId: sent.threadId, text: "Again" });
  });

  it("keeps trying through plain 503s and network errors, and fails the run only after a day", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) => {
      if (!isStart(request)) return undefined;
      if (++calls % 2 === 0) throw new TypeError("fetch failed");
      return new Response("Service Unavailable", { status: 503 });
    });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    const sentAt = h.now;
    await h.runUntil(sentAt + 10 * 60 * 1000, 2000);
    // Eight tries were over in seconds. Ten minutes in, it is still asking.
    expect(calls).toBeGreaterThan(8);
    expect((await read(support, threadId)).activeRun).toMatchObject({
      id: runId,
      status: "queued",
    });
    expect(finished).toEqual([]);
    // Further and further apart, to a cap: not thousands of calls a day.
    await h.runUntil(sentAt + 23 * 60 * 60 * 1000, 5000);
    expect(calls).toBeLessThan(1500);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);

    await h.runUntil(sentAt + 24 * 60 * 60 * 1000 + 4 * 60 * 1000, 5000);
    const thread = await read(support, threadId);
    expect(thread.activeRun).toBeNull();
    expect(thread.latestRun?.error).toEqual({
      code: "run_failed",
      message: "The run could not be started within a day.",
    });
    const after = calls;
    await h.runUntil(h.now + 60 * 60 * 1000 + 1, 5000);
    expect(calls).toBe(after);
  });

  it("spreads every wait it schedules, and never comes back sooner than asked", () => {
    const waits = (random: number, attempt: number, retryAfter: number | null, cap?: number) => {
      noJitter.mockReturnValue(random);
      return retryDelayMs(attempt, retryAfter, cap);
    };
    // No Retry-After: the upper half of a backoff that doubles from a second.
    expect([waits(0, 0, null), waits(0.999, 0, null)]).toEqual([500, 999]);
    expect([waits(0, 4, null), waits(0.999, 4, null)]).toEqual([8_000, 15_992]);
    // As asked, and a little more, never less.
    expect(waits(0, 0, 2_000)).toBe(2_000);
    expect(waits(0.5, 0, 2_000)).toBe(2_250);
    expect(waits(0.5, 0, 300_000)).toBe(315_000);
    // To a cap.
    expect(waits(0.999, 30, null, 120_000)).toBeLessThanOrEqual(120_000);
    expect(waits(0, 30, null, 120_000)).toBe(60_000);
  });

  it("does not tick every run sent in a burst at the same moment", async () => {
    const support = agents();
    const at: number[] = [];
    for (const random of [0, 0.5, 0.999]) {
      noJitter.mockReturnValue(random);
      await support.send(h.appCtx(ALICE), { text: "Hi" });
      const tick = h.takeScheduled().find((job) => job.name === "hercules:tickRun");
      at.push((tick?.at ?? 0) - h.now);
    }
    expect(at).toEqual([180_000, 189_000, 197_982]);
  });

  it("tries again after a 429 with no code, as a proxy in front of Hercules sends", async () => {
    const support = agents();
    let calls = 0;
    api.answerWith((request) =>
      isStart(request) && ++calls === 1
        ? new Response("Too Many Requests", { status: 429, headers: { "retry-after": "3" } })
        : undefined,
    );
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 3_000);
    expect(api.requests.filter(isStart)).toHaveLength(2);
    expect((await read(support, threadId)).activeRun?.live).not.toBeNull();
  });
});

describe("deleting a thread at Hercules", () => {
  const isDelete = (request: Recorded) => request.method === "DELETE";
  const deletedRow = () => h.db.all("deleted_threads")[0];
  const deleteJobs = () =>
    h.scheduled.map((job) => job.name).filter((name) => /delete|purge/i.test(name));

  it("asks again when Hercules says the thread's run is still stopping", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    let busy = 2;
    const askedAt: number[] = [];
    api.answerWith((request) => {
      if (!isDelete(request)) return undefined;
      askedAt.push(h.now);
      // It waited for the run to stop, the run is still going, and nothing was deleted.
      return busy-- > 0
        ? problem(409, "thread_busy", "The thread's run is still going.", 5)
        : undefined;
    });
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    const deletedAt = h.now;
    await h.runUntil(deletedAt + 60 * 1000);
    expect(askedAt).toHaveLength(3);
    // Not before the five seconds Hercules asked for.
    expect((askedAt[1] as number) - (askedAt[0] as number)).toBeGreaterThanOrEqual(5_000);
    expect((askedAt[2] as number) - (askedAt[1] as number)).toBeGreaterThanOrEqual(5_000);
    expect(deletedRow()).toMatchObject({ threadId, remoteGaveUpAt: null });
    expect(deletedRow()?.["remoteDeletedAt"]).toEqual(askedAt[2]);
    expect(deletedRow()?.["purgedAt"]).not.toBeNull();
    // Both done: nothing is left scheduled for the thread.
    await h.runUntil(h.now + 60 * 60 * 1000);
    expect(deleteJobs()).toEqual([]);
  });

  it("keeps asking through a long outage, for a day, then stops and says so", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      isDelete(request) ? new Response("down", { status: 503 }) : undefined,
    );
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    const deletedAt = h.now;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runUntil(deletedAt + 23 * 60 * 60 * 1000, 2000);
    // Far more than the ten tries it used to give up after.
    expect(api.requests.filter(isDelete).length).toBeGreaterThan(100);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null, remoteGaveUpAt: null });
    expect(deleteJobs()).toContain("hercules:deleteTick");
    await h.runUntil(deletedAt + 25 * 60 * 60 * 1000, 2000);
    expect(deletedRow()?.["remoteGaveUpAt"]).not.toBeNull();
    expect(errors.mock.calls.flat().join(" ")).toMatch(/Gave up on deleted thread/);
    errors.mockRestore();
    expect(deleteJobs()).toEqual([]);
  });

  it("does not take one 404 for a deleted thread: Hercules answers 404 while the API is off", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // The agents API is switched off for the app for a while. Every route answers 404.
    let off = true;
    api.answerWith((request) =>
      isDelete(request) && off ? problem(404, "not_found", "Not found.") : undefined,
    );
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    await h.runUntil(h.now + 10 * 60 * 1000);
    expect(api.requests.filter(isDelete).length).toBeGreaterThan(3);
    // Still to be deleted there: the thread and its run are at Hercules.
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null, remoteGaveUpAt: null });
    expect(deleteJobs()).toContain("hercules:deleteTick");

    off = false;
    await h.runUntil(h.now + 15 * 60 * 1000);
    expect(deletedRow()?.["remoteDeletedAt"]).not.toBeNull();
    expect(deleteJobs()).toEqual([]);
  });

  it("takes a thread for gone at Hercules once 404 has been the answer for an hour", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      isDelete(request) ? problem(404, "not_found", "Not found.") : undefined,
    );
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    const deletedAt = h.now;
    await h.runUntil(deletedAt + 55 * 60 * 1000);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null });
    await h.runUntil(deletedAt + 75 * 60 * 1000);
    expect(deletedRow()?.["remoteDeletedAt"]).not.toBeNull();
    expect(deletedRow()).toMatchObject({ remoteGaveUpAt: null });
    expect(deleteJobs()).toEqual([]);
  });

  it("makes the call again when it was lost", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    // The action that calls Hercules never ran.
    await runOnly((name) => name !== "hercules:deleteThread", h.now + 1_000);
    expect(api.requests.filter(isDelete)).toHaveLength(0);
    await h.runUntil(h.now + 10_000);
    expect(api.requests.filter(isDelete)).toHaveLength(1);
    expect(deletedRow()?.["remoteDeletedAt"]).not.toBeNull();
  });

  it("stops at once on an answer that asking again cannot change", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      isDelete(request) ? problem(401, "invalid_api_key", "The key is not valid.") : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    await h.runUntil(h.now + 60 * 60 * 1000);
    errors.mockRestore();
    expect(api.requests.filter(isDelete)).toHaveLength(1);
    expect(deletedRow()?.["remoteGaveUpAt"]).not.toBeNull();
    expect(deleteJobs()).toEqual([]);
  });
});

describe("naming the end user to Hercules", () => {
  const endUsers = (match: (request: Recorded) => boolean) =>
    api.requests.filter(match).map((request) => request.headers.get("hercules-end-user"));
  const isRunRead = (request: Recorded) =>
    request.method === "GET" && /^\/v1\/agents\/runs\/[^/]+$/.test(request.path);
  const isEventsRead = (request: Recorded) =>
    request.method === "GET" && /^\/v1\/agents\/runs\/[^/]+\/events/.test(request.path);
  const isCancel = (request: Recorded) => request.path.endsWith("/cancel");
  const isDelete = (request: Recorded) => request.method === "DELETE";
  const KINDS = [isStart, isRunRead, isEventsRead, isCancel, isDelete];

  it("names the thread's user on every request about their thread or run", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // The stuck-run check reads the run and its events.
    await h.runUntil(h.now + 3 * 60 * 1000);
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    await h.runDue();
    for (const kind of KINDS) {
      const sent = endUsers(kind);
      expect(sent.length).toBeGreaterThan(0);
      expect([...new Set(sent)]).toEqual([ALICE]);
    }
    // The start says it in its body too, as before.
    expect(api.requests.find(isStart)?.body.end_user).toEqual({ token_identifier: ALICE });
  });

  it("names no one on requests about the app's own thread", async () => {
    const support = agents();
    const { threadId } = await support.run(h.appCtx(), { text: "Nightly summary" });
    await h.runDue();
    await h.runUntil(h.now + 3 * 60 * 1000);
    // The app's own threads answer to the owner `app`.
    const own = { threadId, agentId: AGENT_ID, owner: "app", api: { url: API_URL, key: "k" } };
    expect(await h.call(h.component.threads.cancel, own)).toBe(true);
    await h.runDue();
    expect(await h.call(h.component.threads.remove, own)).toBe(true);
    await h.runDue();
    for (const kind of KINDS) {
      const sent = endUsers(kind);
      expect(sent.length).toBeGreaterThan(0);
      expect([...new Set(sent)]).toEqual([null]);
    }
    expect(api.requests.find(isStart)?.body).not.toHaveProperty("end_user");
  });

  it("names the user when it stops a run from the check, and one it gives up on", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Every cancel call fails, so the check is what asks again.
    let down = true;
    api.answerWith((request) =>
      isCancel(request)
        ? down
          ? new Response("down", { status: 503 })
          : Response.json({ id: runId, thread_id: threadId, status: "running" })
        : undefined,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runUntil(h.now + 10 * 60 * 1000);
    down = false;
    // A day after it was sent, a run that was asked to stop is given up on,
    // and Hercules is asked once more to stop it.
    await h.runUntil(h.now + 25 * 60 * 60 * 1000, 4000);
    errors.mockRestore();
    expect((await read(support, threadId)).latestRun?.status).toBe("cancelled");
    const sent = endUsers(isCancel);
    expect(sent.length).toBeGreaterThan(8);
    expect([...new Set(sent)]).toEqual([ALICE]);
  });

  it("names the user when it asks for a run before deleting a thread whose start was not answered", async () => {
    const support = agents();
    api.answerWith((request) => {
      if (isStart(request)) return new Response("down", { status: 503 });
      const runRead = /^\/v1\/agents\/runs\/([^/]+)$/.exec(request.path);
      return request.method === "GET" && runRead !== null
        ? Response.json({ id: runRead[1], thread_id: threadId, status: "queued" })
        : undefined;
    });
    const { threadId } = await support.send(h.appCtx(BOB), { text: "Hi" });
    await h.runDue();
    await support.deleteThread(h.appCtx(BOB), { threadId });
    // The thread's own row is gone: who it was is kept with what is left to do.
    expect(h.db.all("threads")).toEqual([]);
    expect(h.db.all("deleted_threads")[0]).toMatchObject({ owner: `user:${BOB}` });
    await h.runUntil(h.now + 60_000);
    expect(endUsers(isRunRead)).toEqual([BOB]);
    expect(endUsers(isDelete)).toEqual([BOB]);
  });

  it("asks without a user for a thread deleted before its owner was kept, and takes a 404 as it always has", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(support, event(runId, threadId, 9, "run.completed", {}));
    await h.runDue();
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    // As a version before this one wrote the row.
    const row = h.db.all("deleted_threads")[0]!;
    delete row["owner"];
    api.answerWith((request) =>
      isDelete(request) ? problem(404, "not_found", "No such thread.") : undefined,
    );
    await h.runUntil(h.now + 30 * 60 * 1000);
    expect([...new Set(endUsers(isDelete))]).toEqual([null]);
    // One 404 is not "gone": it has to be the answer for an hour.
    expect(h.db.all("deleted_threads")[0]).toMatchObject({
      remoteDeletedAt: null,
      remoteMissingSince: expect.any(Number),
    });
    await h.runUntil(h.now + 60 * 60 * 1000);
    expect(h.db.all("deleted_threads")[0]).toMatchObject({ remoteDeletedAt: expect.any(Number) });
  });

  it("takes a 404 for a user's run as it always has: failed only once it was the answer for an hour", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      request.path.startsWith(`/v1/agents/runs/${runId}`)
        ? problem(404, "not_found", "No such run.")
        : undefined,
    );
    await h.runUntil(h.now + 30 * 60 * 1000);
    expect((await read(support, threadId)).activeRun?.id).toBe(runId);
    await h.runUntil(h.now + 60 * 60 * 1000);
    expect((await read(support, threadId)).latestRun).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: "Hercules has no record of this run." },
    });
    expect([...new Set(endUsers(isRunRead))]).toEqual([ALICE]);
  });

  it("sends an identifier a header cannot carry in a form it can", async () => {
    const support = agents();
    const zoe = "https://auth.app.test|zoë 東京\r\nx: y";
    const { threadId } = await support.send(h.appCtx(zoe), { text: "Hi" });
    await h.runDue();
    expect(h.failedActions).toEqual([]);
    const start = api.requests.find(isStart)!;
    // The body carries the identifier as it is. The header carries its UTF-8, percent-encoded.
    expect(start.body.end_user).toEqual({ token_identifier: zoe });
    const sent = start.headers.get("hercules-end-user")!;
    expect(sent).toBe(`UTF-8''${encodeURIComponent(zoe)}`);
    expect(decodeURIComponent(sent.slice("UTF-8''".length))).toBe(zoe);
    expect((await read(support, threadId, zoe)).activeRun?.live).not.toBeNull();
  });
});

describe("a thread Hercules never took a run on", () => {
  const CHOSEN = "33333333-3333-4333-8333-333333333333";
  const isDelete = (request: Recorded) => request.method === "DELETE";
  const isRunRead = (request: Recorded) =>
    request.method === "GET" && /^\/v1\/agents\/runs\/[^/]+$/.test(request.path);
  const deletedRow = () => h.db.all("deleted_threads")[0];
  const deleteJobs = () =>
    h.scheduled.map((job) => job.name).filter((name) => /delete|purge/i.test(name));
  const called = (from: number) =>
    api.requests.slice(from).map((request) => `${request.method} ${request.path}`);
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  /**
   * Hercules as it answers for a thread it will not open for this caller:
   * it refuses the run, and has no run under the run's id.
   */
  function anotherCallersThread(request: Recorded) {
    if (isStart(request)) return problem(404, "not_found", "Thread not found");
    if (isRunRead(request)) return problem(404, "not_found", "Run not found");
    return undefined;
  }

  it("is deleted here only: Hercules is not asked about a thread it refused to open", async () => {
    const support = agents();
    api.answerWith(anotherCallersThread);
    const { threadId, runId } = await support.send(h.appCtx(ALICE), {
      threadId: CHOSEN,
      text: "Hi",
    });
    await h.runUntil(h.now + 60_000);
    expect(api.requests.filter(isStart)).toHaveLength(1);
    // The run failed as a run Hercules does not take always has, for the page to show.
    expect((await read(support, threadId)).latestRun).toMatchObject({
      id: runId,
      status: "failed",
      error: { code: "agent_not_found" },
    });
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: false });

    const before = api.requests.length;
    // Nothing is going, so there is nothing to stop, here or at Hercules.
    expect(await support.cancel(h.appCtx(ALICE), { threadId })).toBe(false);
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    // Settled at once, with nothing asked.
    expect(deletedRow()).toMatchObject({ threadId, remoteDeletedAt: h.now, attempts: 0 });
    expect(deletedRow()).not.toHaveProperty("unconfirmedRunId");
    await h.runUntil(h.now + 2 * 60 * 60 * 1000);
    expect(called(before)).toEqual([]);

    // Here it is a deleted thread like any other: purged, and its id retired.
    expect(await support.readThread(h.appCtx(ALICE), { threadId })).toBeNull();
    for (const table of ["threads", "runs", "run_requests", "messages"]) {
      expect(h.db.all(table)).toHaveLength(0);
    }
    expect(deletedRow()).toMatchObject({ purgedAt: expect.any(Number), remoteGaveUpAt: null });
    expect(deleteJobs()).toEqual([]);
    const again = await support
      .send(h.appCtx(ALICE), { threadId, text: "Again" })
      .catch((e: unknown) => e);
    expect(errorCode(again)).toBe("thread_deleted");
  });

  it("is not asked about however soon the delete comes, before or after the refusal", async () => {
    const support = agents();
    api.answerWith(anotherCallersThread);
    const { threadId, runId } = await support.send(h.appCtx(ALICE), {
      threadId: CHOSEN,
      text: "Hi",
    });
    // Deleted before the start call ran: whether Hercules takes the run is not known yet.
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null, unconfirmedRunId: runId });
    await h.runUntil(h.now + 2 * 60 * 60 * 1000);

    // Hercules was asked for the run, by the id the component gave it, and
    // never for the thread.
    expect(api.requests.filter(isDelete)).toEqual([]);
    expect(new Set(called(0))).toEqual(
      new Set([`POST /v1/agents/${AGENT_ID}/runs`, `GET /v1/agents/runs/${runId}`]),
    );
    expect(api.requests.filter(isRunRead).length).toBeGreaterThan(1);
    // After an hour of "no such run", there is nothing of this thread at Hercules.
    expect(deletedRow()).toMatchObject({
      remoteDeletedAt: expect.any(Number),
      remoteGaveUpAt: null,
      purgedAt: expect.any(Number),
    });
    expect(deleteJobs()).toEqual([]);
  });

  it("is asked about once Hercules says it has the run whose start it never answered", async () => {
    const support = agents();
    // Hercules took the run, and its answer was lost on the way back.
    api.answerWith((request) =>
      isStart(request) ? new Response("Bad Gateway", { status: 502 }) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: false, status: "queued" });
    api.answerWith((request) =>
      isRunRead(request)
        ? Response.json({ id: runId, thread_id: threadId, status: "running" })
        : undefined,
    );

    const before = api.requests.length;
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null, unconfirmedRunId: runId });
    await h.runUntil(h.now + 60_000);
    // The run first, and the thread only because Hercules has it.
    expect(called(before)).toEqual([
      `GET /v1/agents/runs/${runId}`,
      `DELETE /v1/agents/threads/${threadId}`,
    ]);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: expect.any(Number) });
    expect(deletedRow()).not.toHaveProperty("unconfirmedRunId");
    expect(deleteJobs()).toEqual([]);
  });

  it("is left alone when the run Hercules has is on another thread", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request) ? new Response("Bad Gateway", { status: 502 }) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    api.answerWith((request) =>
      isRunRead(request)
        ? Response.json({ id: runId, thread_id: CHOSEN, status: "running" })
        : undefined,
    );
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 60 * 60 * 1000);
    expect(api.requests.filter(isDelete)).toEqual([]);
    expect(api.requests.filter(isRunRead)).toHaveLength(1);
    expect(deletedRow()).toMatchObject({ remoteGaveUpAt: expect.any(Number) });
    expect(deleteJobs()).toEqual([]);
  });

  it("is deleted at Hercules as before once Hercules has taken a later run on it", async () => {
    const support = agents();
    // The agents API was off for the app: Hercules answers 404 on every route.
    let off = true;
    api.answerWith(() => (off ? problem(404, "not_found", "Not found.") : undefined));
    const { threadId } = await support.send(h.appCtx(ALICE), { threadId: CHOSEN, text: "Hi" });
    await h.runUntil(h.now + 60_000);
    expect((await read(support, threadId)).latestRun?.error?.code).toBe("agent_not_found");

    // The thread is still the caller's here, and the next run is taken.
    off = false;
    const next = await support.send(h.appCtx(ALICE), { threadId, text: "Hi again" });
    await h.runDue();
    expect(h.db.all("runs").map((row) => row["accepted"])).toEqual([false, true]);
    const before = api.requests.length;
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 60_000);
    expect(called(before)).toEqual([`DELETE /v1/agents/threads/${threadId}`]);
    expect(next.threadId).toBe(threadId);
  });

  it("is not one whose first run is queued and taken: that is deleted at Hercules at once", async () => {
    const support = agents();
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Hercules answered the start, and nothing was delivered yet.
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: true, status: "queued", lastSeq: 0 });
    const before = api.requests.length;
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    expect(deletedRow()).toMatchObject({ remoteDeletedAt: null });
    expect(deletedRow()).not.toHaveProperty("unconfirmedRunId");
    await h.runDue();
    expect(called(before)).toEqual([`DELETE /v1/agents/threads/${threadId}`]);
  });

  it("is not one whose run Hercules stopped, though it never answered the start", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await support.cancel(h.appCtx(ALICE), { threadId });
    // The start call was lost. Hercules had the run all the same: it stops it.
    await runOnly((name) => name !== "hercules:startRun", h.now + 3 * 60 * 1000);
    expect(api.requests[0]?.path).toBe(`/v1/agents/runs/${runId}/cancel`);
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: true, status: "cancelled" });
    const before = api.requests.length;
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 10_000);
    expect(called(before)).toEqual([`DELETE /v1/agents/threads/${threadId}`]);
  });

  it("is not one whose run Hercules stops after a day of starts it could not answer", async () => {
    const support = agents();
    api.answerWith((request) =>
      isStart(request) ? new Response("down", { status: 503 }) : undefined,
    );
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runUntil(h.now + 24 * 60 * 60 * 1000 + 4 * 60 * 1000, 5000);
    expect((await read(support, threadId)).latestRun?.error?.message).toBe(
      "The run could not be started within a day.",
    );
    // Asked to stop the run, Hercules answered for it: it had it.
    expect(called(0)).toContain(`POST /v1/agents/runs/${runId}/cancel`);
    expect(h.db.all("runs")[0]).toMatchObject({ accepted: true, status: "failed" });
    const before = api.requests.length;
    expect(await support.deleteThread(h.appCtx(ALICE), { threadId })).toBe(true);
    await h.runUntil(h.now + 10_000);
    expect(called(before)).toEqual([`DELETE /v1/agents/threads/${threadId}`]);
  });
});

describe("large threads", () => {
  /** Rows as the component writes them for a streamed reply, each close to a document's limit. */
  async function addChunks(threadId: string, runId: string, count: number, chars: number) {
    for (let seq = 1; seq <= count; seq++) {
      await h.db.insert("message_chunks", {
        messageId: "msg_big",
        threadId,
        runId,
        seq,
        text: "x".repeat(chars),
      });
    }
  }
  const stored = (table: string) => JSON.stringify(h.db.all(table)).length;

  it("purges in batches bounded by bytes, not only by rows", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // 30 rows of about 780 KB: far more than one mutation may read at once.
    await addChunks(threadId, runId, 30, 780_000);
    await support.deleteThread(h.appCtx(ALICE), { threadId });

    const batches: number[] = [];
    for (let i = 0; i < 100; i++) {
      const jobs = h.takeScheduled();
      const purge = jobs.find((job) => job.name === "threads:purge");
      for (const job of jobs) if (job !== purge) h.scheduled.push(job);
      if (purge === undefined) break;
      const before = stored("message_chunks");
      await h.runJob(purge);
      batches.push(before - stored("message_chunks"));
    }
    expect(h.db.all("message_chunks")).toEqual([]);
    expect(batches.length).toBeGreaterThan(5);
    // A batch stops once it is past 3 MiB, having read at most two more rows.
    expect(Math.max(...batches)).toBeLessThan(3 * 1024 * 1024 + 2 * 800_000);
    expect(h.db.all("deleted_threads")[0]?.["purgedAt"]).not.toBeNull();
    for (const table of ["runs", "run_requests", "messages", "tool_calls"]) {
      expect(h.db.all(table)).toEqual([]);
    }
  });

  it("starts the purge again when a batch threw, once it has stalled", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await addChunks(threadId, runId, 3, 1_000);
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    const deletedAt = h.now;

    // The first batch throws. Convex rolls it back and does not run it again.
    const db = h.db as unknown as { delete(id: string): Promise<void> };
    const remove = db.delete.bind(db);
    db.delete = async () => {
      throw new Error("the batch failed");
    };
    const purge = h.scheduled.find((job) => job.name === "threads:purge")!;
    h.scheduled.splice(h.scheduled.indexOf(purge), 1);
    await expect(h.call(purge.ref as never, purge.args)).rejects.toThrow("the batch failed");
    db.delete = remove;
    expect(h.scheduled.map((job) => job.name)).not.toContain("threads:purge");
    expect(h.db.all("message_chunks")).toHaveLength(3);

    // Not at the first look, a minute in: the purge could still be going.
    await h.runUntil(deletedAt + 90_000);
    expect(h.db.all("message_chunks")).toHaveLength(3);
    // Two minutes with no batch: it has stopped, and is started again.
    await h.runUntil(deletedAt + 3 * 60 * 1000);
    expect(h.db.all("message_chunks")).toEqual([]);
    expect(h.db.all("deleted_threads")[0]?.["purgedAt"]).not.toBeNull();
  });

  it("does not start a second purge beside one that is still going", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // A thread whose purge takes many batches, and here a long time: one
    // batch every half minute, for ten minutes.
    await addChunks(threadId, runId, 80, 780_000);
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    const isPurge = (job: { name: string }) => job.name === "threads:purge";
    /** Runs what is due by `untilMs`, except the purge, which the test paces itself. */
    async function runOthers(untilMs: number) {
      for (;;) {
        const next = h.scheduled
          .filter((job) => !isPurge(job) && job.at <= untilMs)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        h.scheduled.splice(h.scheduled.indexOf(next), 1);
        h.advance(Math.max(0, next.at - h.now));
        await h.runJob(next);
      }
      h.advance(Math.max(0, untilMs - h.now));
    }
    let most = 0;
    let batches = 0;
    for (let step = 0; step < 40 && h.db.all("message_chunks").length > 0; step++) {
      const purges = h.scheduled.filter(isPurge);
      most = Math.max(most, purges.length);
      // One batch of the chain every half minute: it schedules the next one.
      const batch = purges[0];
      if (batch !== undefined) {
        h.scheduled.splice(h.scheduled.indexOf(batch), 1);
        await h.runJob(batch);
        batches++;
      }
      // Meanwhile the tick comes by, every minute.
      await runOthers(h.now + 30_000);
    }
    expect(h.db.all("message_chunks")).toEqual([]);
    expect(batches).toBeGreaterThan(10);
    // The tick came by every minute and left the chain alone: a second chain
    // would have shown as two purges scheduled at once.
    expect(most).toBe(1);
  });

  it("reads a thread up to a byte budget and a capped count, and says there is more", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // Twelve replies of 600 KB each: 7 MiB, more than one read should take.
    for (let n = 0; n < 12; n++) {
      await deliver(
        support,
        event(runId, threadId, 2 + n, "message.completed", {
          message: {
            id: `msg_${n}`,
            thread_id: threadId,
            run_id: runId,
            role: "assistant",
            parts: [{ type: "text", text: String(n).padStart(2, "0") + "x".repeat(600_000) }],
            created_at: "2026-11-15T12:00:01.000Z",
          },
        }),
      );
    }
    const thread = await read(support, threadId);
    expect(thread.hasMore).toBe(true);
    expect(thread.messages.length).toBeGreaterThan(3);
    expect(thread.messages.length).toBeLessThan(10);
    expect(JSON.stringify(thread.messages).length).toBeLessThan(5 * 1024 * 1024);
    // The newest ones, each whole.
    expect(thread.messages.at(-1)?.id).toBe("msg_11");
    for (const message of thread.messages) {
      expect(message.parts[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(message.parts).length).toBeGreaterThan(600_000);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, 0.4])(
    "reads a limit of %s as none, under the cap",
    async (limit) => {
      const support = agents();
      const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
      for (let n = 0; n < 230; n++) {
        await h.db.insert("messages", {
          messageId: `msg_${n}`,
          threadId,
          runId,
          role: "assistant",
          status: "completed",
          parts: [{ type: "text", text: "ok" }],
          segment: 0,
          continuesText: false,
          createdAt: "2026-11-15T12:00:01.000Z",
          runOrder: h.now,
          firstSeq: n + 1,
        });
      }
      // `Math.max(1, NaN)` is NaN, and nothing is equal to NaN: the cap never applied.
      const thread = await support.readThread(h.appCtx(ALICE), { threadId, limit });
      expect(thread?.messages).toHaveLength(100);
      expect(thread?.hasMore).toBe(true);
    },
  );

  it("caps how many messages a caller may ask for", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    for (let n = 0; n < 230; n++) {
      await h.db.insert("messages", {
        messageId: `msg_${n}`,
        threadId,
        runId,
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", text: "ok" }],
        segment: 0,
        continuesText: false,
        createdAt: "2026-11-15T12:00:01.000Z",
        runOrder: h.now,
        firstSeq: n + 1,
      });
    }
    const thread = await support.readThread(h.appCtx(ALICE), { threadId, limit: 100_000 });
    expect(thread?.messages).toHaveLength(200);
    expect(thread?.hasMore).toBe(true);
  });
});

describe("two agents in one app", () => {
  const OTHER_AGENT = "01JDX5ZQ8W3J2K6M9N4P7R1S0V";

  it("reach only their own threads, so one agent's settings never apply to another's", async () => {
    const support = agents({ pageActions: ["open_order"] });
    // The app's other agent shows tool details. This one does not.
    const sales = agents({ agentId: OTHER_AGENT, exposeToolDetails: true });
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    await deliver(
      support,
      event(runId, threadId, 3, "page_action", {
        tool_call_id: "call_page",
        name: "open_order",
        arguments: {},
      }),
      event(runId, threadId, 4, "message.completed", {
        message: {
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
          ],
          created_at: "2026-11-15T12:00:01.000Z",
        },
      }),
    );
    // The same user, through the other agent's functions: the thread is not there.
    expect(await sales.readThread(h.appCtx(ALICE), { threadId })).toBeNull();
    expect(await sales.cancel(h.appCtx(ALICE), { threadId })).toBe(false);
    expect(
      await sales.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(false);
    expect(await sales.deleteThread(h.appCtx(ALICE), { threadId })).toBe(false);
    const sent = await sales
      .send(h.appCtx(ALICE), { threadId, text: "Hi" })
      .catch((e: unknown) => e);
    expect(errorCode(sent)).toBe("not_found");

    const thread = await read(support, threadId);
    expect(JSON.stringify(thread.messages)).not.toContain("web_search");
    expect(thread.activeRun?.id).toBe(runId);
    expect(
      await support.claimPageAction(h.appCtx(ALICE), { threadId, runId, toolCallId: "call_page" }),
    ).toBe(true);
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
    expect((await post(support, token, { event: {} }, verifier)).status).toBe(400);
    const ok = await post(support, token, body, verifier);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ applied: 0, skipped: 0 });
  });

  describe("with the deployment's own environment", () => {
    afterEach(() => vi.unstubAllEnvs());

    /** A delivery token, good at the harness's clock. */
    async function deliveryToken(
      issuer: Awaited<ReturnType<typeof createTestIssuer>>,
      aud: string,
    ) {
      const nowSeconds = Math.floor(h.now / 1000);
      return issuer.sign({
        iss: ISSUER,
        aud,
        sub: `agent:${AGENT_ID}`,
        hercules_principal: "hercules",
        iat: nowSeconds,
        exp: nowSeconds + 600,
      });
    }
    function request(token: string) {
      return new Request(EVENTS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: [] }),
      });
    }

    it("answers 500, which is tried again, while its environment is not set", async () => {
      vi.stubEnv("HERCULES_OIDC_AUTHORITY", "");
      vi.stubEnv("CONVEX_SITE_URL", "");
      vi.stubEnv("CONVEX_CLOUD_URL", "");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await agents().handleEvents(h.appCtx(), request("any"));
      errors.mockRestore();
      expect(response.status).toBe(500);
    });

    it("answers 503 to every delivery while the issuer's keys cannot be fetched, never 401", async () => {
      vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
      vi.stubEnv("CONVEX_SITE_URL", SITE);
      const issuer = await createTestIssuer();
      vi.stubGlobal("fetch", issuer.fetch);
      const support = agents();
      const token = await deliveryToken(issuer, EVENTS_URL);

      issuer.setReachable(false);
      // Hercules reuses one token for minutes, and reads a 401 as this whole
      // deployment refusing it. The second delivery comes before the keys
      // may be fetched again, and must not be told the token is bad.
      for (let delivery = 0; delivery < 2; delivery++) {
        const response = await support.handleEvents(h.appCtx(), request(token));
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        h.advance(1_000);
      }
      issuer.setReachable(true);
      h.advance(30_000);
      expect((await support.handleEvents(h.appCtx(), request(token))).status).toBe(200);
      // The same token again, as Hercules sends it: its `jti` repeating is fine.
      expect((await support.handleEvents(h.appCtx(), request(token))).status).toBe(200);
    });

    it("takes a delivery for the deployment's .convex.site URL behind a custom domain", async () => {
      vi.stubEnv("HERCULES_OIDC_AUTHORITY", ISSUER);
      // The app serves HTTP actions from its own domain. Hercules still signs
      // for the deployment's own URL, and a 401 would stop every delivery.
      vi.stubEnv("CONVEX_SITE_URL", "https://api.example.com");
      vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
      const issuer = await createTestIssuer();
      vi.stubGlobal("fetch", issuer.fetch);
      const support = agents();
      expect(
        (await support.handleEvents(h.appCtx(), request(await deliveryToken(issuer, EVENTS_URL))))
          .status,
      ).toBe(200);
      const elsewhere = await deliveryToken(
        issuer,
        `https://sad-otter-9.convex.site${EVENTS_PATH}`,
      );
      expect((await support.handleEvents(h.appCtx(), request(elsewhere))).status).toBe(401);
    });
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

  it("leaves out the server-only methods, which answer to no caller", async () => {
    const support = agents();
    const fns = support.api();
    expect(fns).not.toHaveProperty("run");
    expect(fns).not.toHaveProperty("readThreadDetails");
    // Why: neither reads who is asking. One user's thread, tool results
    // included, is read with no one signed in at all.
    const { threadId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    expect(await support.readThread(h.appCtx(null), { threadId })).toBeNull();
    expect(await support.readThreadDetails(h.appCtx(null), { threadId })).toMatchObject({
      id: threadId,
      toolCalls: [],
    });
    expect((await support.run(h.appCtx(null), { text: "A job" })).threadId).toEqual(
      expect.any(String),
    );
  });
});

describe("naming the package to Hercules", () => {
  it("has the version package.json has", () => {
    expect(packageJson.name).toBe("@usehercules/agents");
    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(CLIENT_ID).toBe(`agents/${packageJson.version}`);
  });

  // The build writes the version into what is published. `turbo test` builds
  // first; a package that was never built has nothing to check.
  const built = Object.values(
    import.meta.glob(["../../dist/**/*.js", "../../dist/**/*.mjs"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  );
  it.skipIf(built.length === 0)("is built with the version package.json has", () => {
    const versions = built.flatMap((text) =>
      [...text.matchAll(/PACKAGE_VERSION = "([^"]*)"/g)].map((match) => match[1]),
    );
    // In the component's own module and in the bundle the other entry points share.
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(versions)]).toEqual([packageJson.version]);
    // Nothing was left for the runtime to fill in.
    expect(built.some((text) => text.includes("__HERCULES_AGENTS_VERSION__"))).toBe(false);
  });

  it("sends Hercules-Client on every request the app's backend makes", async () => {
    const support = agents();
    const { threadId, runId } = await support.send(h.appCtx(ALICE), { text: "Hi" });
    await h.runDue();
    // The stuck-run check reads the run and its events.
    await h.runUntil(h.now + 3 * 60 * 1000);
    await support.cancel(h.appCtx(ALICE), { threadId });
    await h.runDue();
    await support.deleteThread(h.appCtx(ALICE), { threadId });
    await h.runDue();

    const asked = api.requests.map(
      (request) => `${request.method} ${request.path.replace(/\?.*$/, "")}`,
    );
    expect([...new Set(asked)].sort()).toEqual(
      [
        `POST /v1/agents/${AGENT_ID}/runs`,
        `GET /v1/agents/runs/${runId}`,
        `GET /v1/agents/runs/${runId}/events`,
        `POST /v1/agents/runs/${runId}/cancel`,
        `DELETE /v1/agents/threads/${threadId}`,
      ].sort(),
    );
    for (const request of api.requests) {
      expect(request.headers.get("hercules-client")).toBe(`agents/${packageJson.version}`);
      expect(request.headers.get("hercules-version")).toBe("2025-12-09");
    }
  });
});
