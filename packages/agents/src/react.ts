"use client";
/**
 * `useAgentThread`: a chat with a Hercules agent on a page of a Convex app.
 * It takes what Convex's own `useQuery` and `useMutation` return, so the app
 * keeps its own client and auth:
 *
 * ```tsx
 * const [threadId, setThreadId] = useState<string | null>(null);
 * const chat = useAgentThread({
 *   threadId,
 *   thread: useQuery(api.agent.thread, threadId === null ? "skip" : { threadId }),
 *   send: useMutation(api.agent.send),
 *   cancel: useMutation(api.agent.cancel),
 *   claimPageAction: useMutation(api.agent.claimPageAction),
 *   pageActions: { open_order: ({ orderId }) => navigate(`/orders/${orderId}`) },
 * });
 * const started = await chat.send(text);
 * if (started) setThreadId(started.threadId);
 * ```
 *
 * The reply streams from the run's live URL until Convex has it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentThread } from "./agents";
import { LiveRun, mergeThread, type PendingInput, type ViewMessage } from "./live-thread";
import { followRun, RunStreamError } from "./stream";

export {
  LiveRun,
  mergeThread,
  type PendingInput,
  type ViewMessage,
  type ViewPart,
  type ViewToolCallPart,
} from "./live-thread";
export type { AgentThread } from "./agents";

/** Runs a page action. What it returns goes nowhere: page actions are one-way. */
export type PageActionHandler = (
  // The agent writes the arguments; check them before acting on them.
  args: any,
  info: { toolCallId: string; runId: string },
) => void | Promise<void>;

export interface SendMutationArgs {
  threadId?: string;
  text: string;
  context?: Record<string, unknown>;
  anonymousId?: string;
}

export interface UseAgentThreadOptions {
  /**
   * The thread on the page. Null before its first message; leave it out to
   * take it from `thread`.
   */
  threadId?: string | null;
  /** `useQuery(api.agent.thread, ...)`: undefined while it loads. */
  thread: AgentThread | null | undefined;
  /** `useMutation(api.agent.send)`. */
  send: (args: SendMutationArgs) => Promise<{ threadId: string; runId: string }>;
  /** `useMutation(api.agent.cancel)`. */
  cancel?: (args: { threadId: string; anonymousId?: string }) => Promise<boolean>;
  /** `useMutation(api.agent.claimPageAction)`. Page actions run only with it. */
  claimPageAction?: (args: {
    threadId: string;
    runId: string;
    toolCallId: string;
    anonymousId?: string;
  }) => Promise<boolean>;
  /** The page's actions, by name. One open tab runs each call. */
  pageActions?: Readonly<Record<string, PageActionHandler>>;
  /** A visitor's id, when the agent takes visitors who are not signed in. */
  anonymousId?: string;
  fetch?: typeof fetch;
}

/**
 * - `loading`: the thread is being read.
 * - `submitted`: a message is on its way, or the run has not started writing.
 * - `streaming`: the reply is being written.
 * - `ready`: nothing is going; a new message can be sent.
 */
export type AgentThreadStatus = "loading" | "ready" | "submitted" | "streaming";

/** A run that failed, or a message that could not be sent. */
export class AgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export interface UseAgentThreadResult {
  messages: ViewMessage[];
  status: AgentThreadStatus;
  /** Sends a message. Resolves to the thread and run, or null when it was not sent (see `error`). */
  send: (
    text: string,
    options?: { context?: Record<string, unknown> },
  ) => Promise<{ threadId: string; runId: string } | null>;
  /** Stops the reply being written. */
  cancel: () => Promise<void>;
  error: Error | null;
}

function toError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (typeof data === "object" && data !== null && "code" in data && "message" in data) {
      const { code, message } = data as { code: unknown; message: unknown };
      if (typeof code === "string" && typeof message === "string") {
        return new AgentError(code, message);
      }
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parseArguments(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

let pendingCounter = 0;

export function useAgentThread(options: UseAgentThreadOptions): UseAgentThreadResult {
  const { thread } = options;
  const threadId = options.threadId === undefined ? (thread?.id ?? null) : options.threadId;

  // The latest options, read by callbacks that outlive a render.
  const latest = useRef(options);
  latest.current = options;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const [pending, setPending] = useState<PendingInput[]>([]);
  const [sending, setSending] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [, setVersion] = useState(0);
  const live = useRef<LiveRun | null>(null);
  const attempted = useRef(new Set<string>());
  const renderQueued = useRef(false);
  const warnedNoClaim = useRef(false);

  const queueRender = useCallback(() => {
    if (renderQueued.current) return;
    renderQueued.current = true;
    const flush = () => {
      renderQueued.current = false;
      setVersion((version) => version + 1);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }, []);

  const runPageAction = useCallback(
    async (runThreadId: string, runId: string, toolCallId: string, name: string, args: unknown) => {
      const { pageActions, claimPageAction, anonymousId } = latest.current;
      const handler = pageActions?.[name];
      if (handler === undefined || attempted.current.has(toolCallId)) return;
      if (claimPageAction === undefined) {
        if (!warnedNoClaim.current) {
          warnedNoClaim.current = true;
          console.warn("useAgentThread: pass claimPageAction to run page actions");
        }
        return;
      }
      attempted.current.add(toolCallId);
      try {
        const claimed = await claimPageAction({
          threadId: runThreadId,
          runId,
          toolCallId,
          ...(anonymousId !== undefined && { anonymousId }),
        });
        if (claimed) await handler(args, { toolCallId, runId });
      } catch (failure) {
        console.error(`Page action ${name} failed`, failure);
      }
    },
    [],
  );

  const activeRun = thread?.activeRun ?? null;
  const activeRunId = activeRun?.id ?? null;
  const liveUrl = activeRun?.live?.url ?? null;
  const liveToken = activeRun?.live?.token ?? null;
  const liveThreadId = thread?.id ?? null;

  useEffect(() => {
    if (activeRunId === null || liveUrl === null || liveToken === null || liveThreadId === null) {
      return;
    }
    const run =
      live.current?.runId === activeRunId ? live.current : new LiveRun(activeRunId, liveThreadId);
    live.current = run;
    setStreamError(null);
    const controller = new AbortController();
    async function follow() {
      try {
        for await (const event of followRun({
          url: liveUrl as string,
          token: liveToken as string,
          after: run.lastSeq,
          signal: controller.signal,
          ...(latest.current.fetch !== undefined && { fetch: latest.current.fetch }),
        })) {
          if (!run.apply(event)) continue;
          if (event.type === "page_action") {
            void runPageAction(
              event.thread_id || run.threadId,
              event.run_id,
              event.data.tool_call_id,
              event.data.name,
              event.data.arguments,
            );
          }
          queueRender();
        }
      } catch (failure) {
        // Convex still gets the reply; only the live view stops.
        if (!controller.signal.aborted && failure instanceof RunStreamError) {
          setStreamError(failure);
        }
      }
    }
    void follow();
    return () => controller.abort();
  }, [activeRunId, liveUrl, liveToken, liveThreadId, queueRender, runPageAction]);

  // Page actions no tab has run yet, such as those sent while this page was closed.
  useEffect(() => {
    if (thread === null || thread === undefined) return;
    for (const action of thread.pageActions) {
      void runPageAction(
        thread.id,
        action.runId,
        action.toolCallId,
        action.name,
        parseArguments(action.argumentsJson),
      );
    }
  }, [thread, runPageAction]);

  // Messages Convex now shows are no longer pending.
  useEffect(() => {
    if (thread === null || thread === undefined) return;
    const shown = new Set(thread.messages.flatMap((m) => (m.role === "user" ? [m.run_id] : [])));
    setPending((inputs) => {
      const next = inputs.filter((input) => input.runId === null || !shown.has(input.runId));
      return next.length === inputs.length ? inputs : next;
    });
  }, [thread]);

  const send = useCallback<UseAgentThreadResult["send"]>(async (text, sendOptions) => {
    const key = `pending:${++pendingCounter}`;
    setPending((inputs) => [
      ...inputs,
      { key, text, runId: null, createdAt: new Date().toISOString() },
    ]);
    setSending((count) => count + 1);
    setError(null);
    try {
      const { anonymousId } = latest.current;
      const currentThreadId = threadIdRef.current;
      const started = await latest.current.send({
        ...(currentThreadId !== null && { threadId: currentThreadId }),
        text,
        ...(sendOptions?.context !== undefined && { context: sendOptions.context }),
        ...(anonymousId !== undefined && { anonymousId }),
      });
      setPending((inputs) =>
        inputs.map((input) => (input.key === key ? { ...input, runId: started.runId } : input)),
      );
      return started;
    } catch (failure) {
      setPending((inputs) => inputs.filter((input) => input.key !== key));
      setError(toError(failure));
      return null;
    } finally {
      setSending((count) => count - 1);
    }
  }, []);

  const cancel = useCallback(async () => {
    const { cancel: cancelRun, anonymousId } = latest.current;
    const currentThreadId = threadIdRef.current;
    if (cancelRun === undefined || currentThreadId === null) return;
    try {
      await cancelRun({
        threadId: currentThreadId,
        ...(anonymousId !== undefined && { anonymousId }),
      });
    } catch (failure) {
      setError(toError(failure));
    }
  }, []);

  const messages = mergeThread(thread, live.current, pending);

  const latestRun = thread?.latestRun ?? null;
  const runError = useMemo(
    () =>
      latestRun !== null && latestRun.status === "failed" && latestRun.error !== null
        ? new AgentError(latestRun.error.code, latestRun.error.message)
        : null,
    // A new error only for another run or another failure.
    [latestRun?.id, latestRun?.status, latestRun?.error?.code],
  );

  const liveRun = live.current !== null && live.current.runId === activeRunId ? live.current : null;
  const waitingForRun = pending.some((input) => input.runId !== null);
  let status: AgentThreadStatus;
  if (sending > 0) status = "submitted";
  else if (threadId !== null && thread === undefined) status = "loading";
  else if (
    activeRun?.status === "running" &&
    (liveRun?.hasContent() === true || messages.some((m) => m.status === "streaming"))
  ) {
    status = "streaming";
  } else if (activeRun !== null || waitingForRun) status = "submitted";
  else status = "ready";

  return {
    messages,
    status,
    send,
    cancel,
    error: error ?? streamError ?? (activeRun === null ? runError : null),
  };
}
