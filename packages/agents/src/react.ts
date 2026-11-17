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
 *   pageActions: {
 *     // A model writes the arguments: check the id, then build the URL from it.
 *     open_order: ({ orderId }) => {
 *       if (typeof orderId !== "string" || !/^[\w-]{1,64}$/.test(orderId)) return;
 *       navigate(`/orders/${encodeURIComponent(orderId)}`);
 *     },
 *   },
 * });
 * const started = await chat.send(text);
 * if (started) setThreadId(started.threadId);
 * ```
 *
 * The reply streams from the run's live URL until Convex has it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentThread } from "./agents";
import { AgentError, toAgentError as toError } from "./errors";
import { LiveRun, mergeThread, type PendingInput, type ViewMessage } from "./live-thread";
import { createPageActionRunner, type PageActionHandler } from "./page-actions";
import { followRun, RunStreamError } from "./stream";

export { AgentError } from "./errors";
export { RunStreamError } from "./stream";
export {
  LiveRun,
  mergeThread,
  type PendingInput,
  type ViewMessage,
  type ViewPart,
  type ViewToolCallPart,
} from "./live-thread";
export type { PageActionHandler } from "./page-actions";
export type { AgentThread } from "./agents";

export interface SendMutationArgs {
  threadId?: string;
  text: string;
  context?: Record<string, unknown>;
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
  cancel?: (args: { threadId: string }) => Promise<boolean>;
  /** `useMutation(api.agent.claimPageAction)`. Page actions run only with it. */
  claimPageAction?: (args: {
    threadId: string;
    runId: string;
    toolCallId: string;
  }) => Promise<boolean>;
  /**
   * The page's actions, by name. One open tab runs each call, once Hercules
   * has delivered it to the app and while it is less than two minutes old.
   * One that came later is not run: `thread.pageActions` lists it with
   * `status: "expired"`, for the page to say so. A handler's arguments are
   * untrusted input: see `PageActionHandler`.
   */
  pageActions?: Readonly<Record<string, PageActionHandler>>;
  fetch?: typeof fetch;
}

/**
 * - `loading`: the thread is being read.
 * - `submitted`: a message is on its way, or the run has not started writing.
 * - `streaming`: the reply is being written.
 * - `ready`: nothing is going; a new message can be sent.
 */
export type AgentThreadStatus = "loading" | "ready" | "submitted" | "streaming";

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
  /**
   * What went wrong, or null:
   *
   * - An `AgentError` with a `code`: the message was not sent (`send`'s
   *   codes), or the latest run failed (the run's code, such as
   *   `out_of_credits`). For a limit it has `retryAfterSeconds`.
   * - A `RunStreamError` while a run is going: the live view of the reply
   *   could not be read, for example with `status` 429 when more than ten
   *   tabs stream the same run. The run is not affected, and the reply still
   *   arrives through `thread`. It clears when the run is over.
   * - Any other `Error` a mutation threw, such as a lost connection.
   */
  error: AgentError | RunStreamError | Error | null;
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
  // The stream failure of one run. It is shown only while that run is going,
  // so it never comes back with the next run.
  const [streamFailure, setStreamFailure] = useState<{
    runId: string;
    error: RunStreamError;
  } | null>(null);
  const [, setVersion] = useState(0);
  const live = useRef<LiveRun | null>(null);
  const renderQueued = useRef(false);
  const pageActionRunner = useRef<ReturnType<typeof createPageActionRunner> | null>(null);
  pageActionRunner.current ??= createPageActionRunner({
    name: "useAgentThread",
    handlers: () => latest.current.pageActions,
    claim: () => latest.current.claimPageAction,
  });

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
    setStreamFailure(null);
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
          queueRender();
        }
      } catch (failure) {
        // Convex still gets the reply; only the live view stops.
        if (!controller.signal.aborted && failure instanceof RunStreamError) {
          setStreamFailure({ runId: run.runId, error: failure });
        }
      }
    }
    void follow();
    return () => controller.abort();
  }, [activeRunId, liveUrl, liveToken, liveThreadId, queueRender]);

  // The page actions Hercules delivered that no tab has taken yet. The live
  // stream shows a page action in the chat; this is what runs it.
  useEffect(() => {
    pageActionRunner.current?.(thread);
  }, [thread]);

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
      const currentThreadId = threadIdRef.current;
      const started = await latest.current.send({
        ...(currentThreadId !== null && { threadId: currentThreadId }),
        text,
        ...(sendOptions?.context !== undefined && { context: sendOptions.context }),
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
    const { cancel: cancelRun } = latest.current;
    const currentThreadId = threadIdRef.current;
    if (cancelRun === undefined || currentThreadId === null) return;
    try {
      await cancelRun({ threadId: currentThreadId });
    } catch (failure) {
      setError(toError(failure));
    }
  }, []);

  const messages = mergeThread(thread, live.current, pending);

  const latestRun = thread?.latestRun ?? null;
  const runError = useMemo(
    () =>
      latestRun !== null && latestRun.status === "failed" && latestRun.error !== null
        ? new AgentError(
            latestRun.error.code,
            latestRun.error.message,
            latestRun.error.retryAfterSeconds,
          )
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
    // A stream that failed matters only while its run is going: once Convex
    // has the run's end, the reply is there and the live view is not needed.
    error:
      error ??
      (activeRun === null
        ? runError
        : streamFailure?.runId === activeRun.id
          ? streamFailure.error
          : null),
  };
}
