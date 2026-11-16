/**
 * A stand-in for a Convex app with the agent functions `support.api()`
 * builds, and for the run's live stream at Hercules. Tests drive it the way
 * the component and Hercules would: by changing the thread and writing events.
 */
import {
  anyApi,
  getFunctionName,
  type ApiFromModules,
  type FilterApi,
  type FunctionReference,
} from "convex/server";
import { ConvexError } from "convex/values";
import type { AgentThread, HerculesAgents } from "../agents";
import type { HerculesConvexClient } from "../tanstack";

type AgentModule = ReturnType<HerculesAgents["api"]>;
/** `api` as `convex/_generated/api` types it for an app whose `convex/agent.ts` exports `support.api()`. */
export type AppApi = FilterApi<
  ApiFromModules<{ agent: AgentModule }>,
  FunctionReference<any, "public">
>;
export const api = anyApi as unknown as AppApi;

export const THREAD = "9c2d7a10-55e1-4f0b-8d3c-2a1b0c9d8e7f";
export const RUN = "4b1f2c1e-8a8b-4c3f-9d55-0b6f1d2e3a4b";
export const LIVE_URL = `https://api.hercules.test/v1/agents/runs/${RUN}/events`;
const AT = "2026-11-15T12:00:00.000Z";

export function frame(seq: number, type: string, data: unknown = {}, runId = RUN): string {
  const event = {
    id: `${runId}:${seq}`,
    seq,
    run_id: runId,
    thread_id: THREAD,
    type,
    created_at: AT,
    data,
  };
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function userMessage(text: string, runId = RUN): AgentThread["messages"][number] {
  return {
    id: `${runId}:input`,
    thread_id: THREAD,
    run_id: runId,
    role: "user",
    parts: [{ type: "text", text }],
    created_at: AT,
    status: "completed",
  };
}

export function assistantMessage(
  id: string,
  parts: AgentThread["messages"][number]["parts"],
  status: "streaming" | "completed" | "incomplete" = "completed",
  runId = RUN,
): AgentThread["messages"][number] {
  return { id, thread_id: THREAD, run_id: runId, role: "assistant", parts, created_at: AT, status };
}

export function runningThread(messages: AgentThread["messages"], runId = RUN): AgentThread {
  return {
    id: THREAD,
    agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
    hasMore: false,
    messages,
    activeRun: {
      id: runId,
      status: "running",
      progress: null,
      live: { url: LIVE_URL, token: "run-token" },
      lastSeq: 0,
      created_at: AT,
      stopping: false,
    },
    latestRun: { id: runId, status: "running", error: null, cappedReason: null, finished_at: null },
    pageActions: [],
  };
}

export function settledThread(
  messages: AgentThread["messages"],
  latestRun: AgentThread["latestRun"] = {
    id: RUN,
    status: "completed",
    error: null,
    cappedReason: null,
    finished_at: null,
  },
): AgentThread {
  return {
    id: THREAD,
    agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
    hasMore: false,
    messages,
    activeRun: null,
    latestRun,
    pageActions: [],
  };
}

/** A page action Hercules delivered to the app just now, waiting for a tab. */
export function pendingPageAction(
  toolCallId: string,
  args: unknown,
  runId = RUN,
): AgentThread["pageActions"][number] {
  return {
    toolCallId,
    runId,
    name: "open_order",
    argumentsJson: JSON.stringify(args),
    created_at: new Date().toISOString(),
    status: "pending",
  };
}

interface Call {
  name: string;
  args: any;
}

export function createApp(initial: AgentThread | null = null) {
  let thread = initial;
  const watchers = new Set<() => void>();
  const calls: Call[] = [];
  const claimed = new Set<string>();
  let sendError: unknown = null;
  let streamFrames: string[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetchUrls: string[] = [];
  const fetchHeaders: Headers[] = [];
  let fetchAnswer: (() => Response) | null = null;
  const encoder = new TextEncoder();

  function setThread(next: AgentThread | null) {
    thread = next;
    for (const watcher of [...watchers]) watcher();
  }

  const client: HerculesConvexClient = {
    async mutation(reference, args) {
      const name = getFunctionName(reference);
      calls.push({ name, args });
      if (name === "agent:send") {
        if (sendError !== null) throw sendError;
        setThread(runningThread([...(thread?.messages ?? []), userMessage(args.text)]));
        return { threadId: args.threadId ?? THREAD, runId: RUN };
      }
      if (name === "agent:claimPageAction") {
        // As the component does: only a delivered page action, and only once.
        const key = `${args.runId}:${args.toolCallId}`;
        const listed = thread?.pageActions.some(
          (action) => `${action.runId}:${action.toolCallId}` === key,
        );
        if (listed !== true || claimed.has(key)) return false;
        claimed.add(key);
        return true;
      }
      if (name === "agent:cancel") return true;
      throw new Error(`unexpected mutation ${name}`);
    },
    async query(reference, args) {
      calls.push({ name: getFunctionName(reference), args });
      return thread;
    },
    watchQuery(reference, args) {
      calls.push({ name: `watch ${getFunctionName(reference)}`, args });
      return {
        onUpdate(callback) {
          watchers.add(callback);
          return () => watchers.delete(callback);
        },
        localQueryResult: () => thread,
      };
    },
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchUrls.push(String(input));
    fetchHeaders.push(new Headers(init?.headers));
    if (fetchAnswer !== null) return fetchAnswer();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        for (const text of streamFrames) controller.enqueue(encoder.encode(text));
        streamFrames = [];
      },
    });
    init?.signal?.addEventListener("abort", () => {
      try {
        streamController?.error(new DOMException("aborted", "AbortError"));
      } catch {
        // Already closed.
      }
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  return {
    client,
    calls,
    fetch: fetchFn,
    fetchUrls,
    fetchHeaders,
    thread: () => thread,
    setThread,
    /** Hercules delivers a page action to the app: the thread now lists it. */
    deliverPageAction(action: AgentThread["pageActions"][number]) {
      if (thread !== null) setThread({ ...thread, pageActions: [...thread.pageActions, action] });
    },
    callsTo: (name: string) => calls.filter((call) => call.name === name),
    watching: () => watchers.size,
    failSendWith(code: string, message: string) {
      sendError = new ConvexError({ code, message });
    },
    /** Takes messages again, after `failSendWith`. */
    acceptSends() {
      sendError = null;
    },
    answerStreamWith(answer: () => Response) {
      fetchAnswer = answer;
    },
    /** Writes events to the live stream, or queues them for the next connection. */
    push(...frames: string[]) {
      if (streamController === null) streamFrames.push(...frames);
      else for (const text of frames) streamController.enqueue(encoder.encode(text));
    },
    closeStream() {
      streamController?.close();
      streamController = null;
    },
  };
}

export type App = ReturnType<typeof createApp>;
