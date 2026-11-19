"use client";
/**
 * `@usehercules/agents/tanstack`: a Hercules agent behind TanStack AI's
 * `useChat`, in a Convex app. The page keeps TanStack's chat state and UI
 * kit; Convex keeps the thread.
 *
 * ```tsx
 * function AgentChat({ threadId }: { threadId: string }) {
 *   // The app's own client, signed in as the user.
 *   const convex = useConvex();
 *   // Once per chat: `useChat` keeps the first connection it gets.
 *   const [connection] = useState(() => herculesConnection(convex, api.agent));
 *   const chat = useChat({ connection, threadId, persistence: true });
 *   useThreadSync(chat, api.agent.thread, { threadId });
 *   useEffect(() => {
 *     connection.setPageActions({ open_order: ({ orderId }) => openOrder(orderId) });
 *     return () => connection.setPageActions(undefined);
 *   }, [connection]);
 * }
 * ```
 *
 * `threadId` is the page's: a UUID it makes for a new chat
 * (`crypto.randomUUID()`), and keeps, in the URL say. The first message
 * opens the thread under it.
 *
 * The chat is for signed-in users. Render it once `useConvexAuth()` says
 * Convex has one: it reads its thread when it mounts, and a thread read as
 * no one comes back empty.
 */
import type {
  ChatHydrateOptions,
  ChatHydrationResult,
  ConnectConnectionAdapter,
  RunAgentInputContext,
} from "@tanstack/ai-client";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai/client";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useRef } from "react";
import {
  notSentChunk,
  RunChunks,
  syncThread,
  threadToUIMessages,
  type SyncableChat,
} from "./ag-ui";
import type { AgentThread } from "./agents";
import { AgentError, toAgentError } from "./errors";
import { createPageActionRunner, type PageActionHandlers } from "./page-actions";
import { followRun, RunStreamError, type RunStreamOptions } from "./stream";

export {
  agentErrorCode,
  PAGE_ACTION_OUTPUT,
  PROGRESS_EVENT,
  type HerculesMessageMetadata,
  type HerculesToolOutput,
  type SyncableChat,
} from "./ag-ui";
export type { PageActionHandler, PageActionHandlers } from "./page-actions";
export type { AgentThread } from "./agents";

// Not exported: `/convex` has the `SendArgs` an app's backend uses, and these
// two only spell out `HerculesAgentApi`.
type SendArgs = {
  threadId?: string;
  text: string;
  context?: Record<string, any>;
};

type ThreadQueryArgs = {
  threadId: string;
  limit?: number;
};

/**
 * The app's agent functions, as `support.api()` builds them and
 * `convex/_generated/api` names them: pass `api.agent`.
 */
export interface HerculesAgentApi {
  send: FunctionReference<"mutation", "public", SendArgs, { threadId: string; runId: string }>;
  thread: FunctionReference<"query", "public", ThreadQueryArgs, AgentThread | null>;
  cancel?: FunctionReference<"mutation", "public", { threadId: string }, boolean>;
  claimPageAction?: FunctionReference<
    "mutation",
    "public",
    { threadId: string; runId: string; toolCallId: string },
    boolean
  >;
}

/**
 * What the adapter needs of the app's Convex client: a `ConvexReactClient`
 * has it. Pass the app's own, from `useConvex()`: a second client is not
 * signed in.
 */
export interface HerculesConvexClient {
  mutation(mutation: FunctionReference<"mutation">, args: any): Promise<any>;
  query(query: FunctionReference<"query">, args: any): Promise<any>;
  watchQuery(
    query: FunctionReference<"query">,
    args: any,
  ): { onUpdate(callback: () => void): () => void; localQueryResult(): unknown };
}

export interface HerculesConnectionOptions {
  /**
   * The page's actions, by name. When the agent calls one and Hercules has
   * delivered it to the app, the adapter claims it through `claimPageAction`,
   * so only one open tab runs it, and runs it. One that is two minutes old is
   * skipped.
   */
  pageActions?: PageActionHandlers;
  fetch?: typeof fetch;
  /** Reconnecting to the run's live stream. */
  retry?: RunStreamOptions["retry"];
  /**
   * How long to wait, after the live stream ends, for Convex to record that
   * the run is over before the chat takes a new message. Until it has, a new
   * message would find the thread busy. Also how long a message sent right
   * after `chat.stop()` waits for the stopped run to end before it is
   * refused as `thread_busy`. Defaults to 10 seconds.
   */
  settleTimeoutMs?: number;
}

/** TanStack AI's `ConnectConnectionAdapter`, with every optional member a Hercules thread can serve. */
export interface HerculesConnection extends ConnectConnectionAdapter {
  connect: (
    messages: Array<UIMessage> | Array<ModelMessage>,
    data: Record<string, any> | undefined,
    abortSignal: AbortSignal | undefined,
    runContext: RunAgentInputContext,
  ) => AsyncIterable<StreamChunk>;
  hydrate: (threadId: string, options?: ChatHydrateOptions) => Promise<ChatHydrationResult>;
  joinRun: (runId: string, abortSignal?: AbortSignal) => AsyncIterable<StreamChunk>;
  cancelRun: (run: { runId: string; threadId: string }) => Promise<void>;
  /**
   * Replaces the page's actions, for handlers that change with the page:
   * set them in an effect, and clear them with `undefined` in its cleanup.
   */
  setPageActions: (pageActions: PageActionHandlers | undefined) => void;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

function textOfMessage(message: UIMessage | ModelMessage): string | null {
  if ("parts" in message && Array.isArray(message.parts)) {
    return message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
  }
  const content = (message as ModelMessage).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part.type === "text" ? part.content : "")).join("");
  }
  return null;
}

/** The text of the message being sent: the last one from the user. */
function lastUserText(messages: ReadonlyArray<UIMessage | ModelMessage>): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as UIMessage | ModelMessage;
    if (message.role !== "user") continue;
    const text = textOfMessage(message);
    return text === null || text.trim().length === 0 ? null : text;
  }
  return null;
}

function contextOf(data: Record<string, any> | undefined): Record<string, any> | undefined {
  const context: unknown = data?.["context"];
  return typeof context === "object" && context !== null && !Array.isArray(context)
    ? (context as Record<string, any>)
    : undefined;
}

type ThreadValue = AgentThread | null;

interface ThreadWatch {
  /** The thread as Convex has it now, or undefined while it loads or cannot be read. */
  current(): ThreadValue | undefined;
  /** Calls `listener` with the thread as it is now, and each time it changes. */
  each(listener: (thread: ThreadValue) => void): void;
  /** Resolves with the first value `pick` returns for the thread, or undefined on abort or timeout. */
  until<T>(
    pick: (thread: ThreadValue) => T | undefined,
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<T | undefined>;
  stop(): void;
}

function watchThread(
  convex: HerculesConvexClient,
  query: HerculesAgentApi["thread"],
  args: ThreadQueryArgs,
): ThreadWatch {
  const watch = convex.watchQuery(query, args);
  const listeners = new Set<() => void>();
  const unsubscribe = watch.onUpdate(() => {
    for (const listener of [...listeners]) listener();
  });
  function current(): ThreadValue | undefined {
    try {
      return watch.localQueryResult() as ThreadValue | undefined;
    } catch {
      // `until` reports a thread that cannot be read.
      return undefined;
    }
  }
  return {
    current,
    each(listener) {
      function check() {
        const thread = current();
        if (thread !== undefined) listener(thread);
      }
      listeners.add(check);
      check();
    },
    until(pick, signal, timeoutMs) {
      return new Promise((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: ReturnType<typeof pick>, error?: unknown) => {
          if (done) return;
          done = true;
          listeners.delete(check);
          signal?.removeEventListener("abort", onAbort);
          if (timer !== undefined) clearTimeout(timer);
          if (error === undefined) resolve(value);
          else reject(error);
        };
        function onAbort() {
          finish(undefined);
        }
        function check() {
          let thread: unknown;
          try {
            thread = watch.localQueryResult();
          } catch (error) {
            finish(undefined, error ?? new Error("The thread could not be read"));
            return;
          }
          // Still loading.
          if (thread === undefined) return;
          const picked = pick(thread as ThreadValue);
          if (picked !== undefined) finish(picked);
        }
        if (signal?.aborted) {
          finish(undefined);
          return;
        }
        listeners.add(check);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs !== undefined) timer = setTimeout(() => finish(undefined), timeoutMs);
        check();
      });
    },
    stop() {
      listeners.clear();
      unsubscribe();
    },
  };
}

/**
 * A TanStack AI connection to a Hercules agent through the app's Convex
 * functions. Make it once per chat, in the component, from the app's own
 * client: `const convex = useConvex()`, then
 * `useState(() => herculesConnection(convex, api.agent))`. `useChat` keeps
 * the first connection it gets for a thread, and a client made outside the
 * app's `ConvexProvider` is not signed in.
 *
 * - `connect` sends the message with the app's `send` mutation, then streams
 *   the run's live events from Hercules as AG-UI chunks, resuming with
 *   `Last-Event-ID`. It ends once Convex has the run's end, so the next
 *   message never finds the thread busy. A message sent right after
 *   `chat.stop()`, while the stopped run is still ending, waits for it to
 *   end and is then sent. The stream is read only until then:
 *   when Convex has the run's end first, or the stream cannot be read at all
 *   (refused, or too many tabs streaming the run), the reply comes from
 *   Convex. A live view that fails is not an error of the chat.
 * - `hydrate` reads the thread once, for `persistence: true`.
 * - `joinRun` replays a run still going from its start, after a reload.
 * - `cancelRun` stops the run with the app's `cancel` mutation.
 *
 * Page actions are one-way: each comes to TanStack as a tool call with the
 * result "sent to the page", so TanStack never starts a run of its own, and
 * the adapter runs the page's handler. It runs it once Hercules has
 * delivered the call to the app (the thread query then lists it), after
 * claiming it, and skips one that is two minutes old.
 *
 * A message that completes as something other than what streamed of it (a
 * step Hercules retried streams its text twice) replaces the chat's messages
 * with the thread as Convex has it and the message as it completed.
 */
export function herculesConnection(
  convex: HerculesConvexClient,
  api: HerculesAgentApi,
  options: HerculesConnectionOptions = {},
): HerculesConnection {
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  let pageActions = options.pageActions;
  /** The thread of each run this page has seen, for `joinRun`. */
  const runThreads = new Map<string, string>();
  const claimPageAction = api.claimPageAction;
  const runPendingPageActions = createPageActionRunner({
    name: "herculesConnection",
    handlers: () => pageActions,
    claim: () =>
      claimPageAction === undefined
        ? undefined
        : (args) => convex.mutation(claimPageAction, args) as Promise<boolean>,
  });

  function threadArgs(threadId: string, limit?: number): ThreadQueryArgs {
    return { threadId, ...(limit !== undefined && { limit }) };
  }

  /**
   * Whether the thread is free again after a stop: true once the run that
   * was stopping is over. False when no stop is why the thread is busy (a
   * run nobody stopped is going), and when the stop did not land in time.
   */
  async function stopLanded(threadId: string, signal: AbortSignal | undefined): Promise<boolean> {
    const watch = watchThread(convex, api.thread, threadArgs(threadId));
    try {
      const free = await watch.until(
        (thread) => {
          if (thread === null) return false;
          if (thread.activeRun === null) return true;
          return thread.activeRun.stopping ? undefined : false;
        },
        signal,
        settleTimeoutMs,
      );
      return free === true;
    } catch {
      // The thread cannot be read: the refusal stands.
      return false;
    } finally {
      watch.stop();
    }
  }

  /**
   * Sends the message. One refused as `thread_busy` while the thread's run
   * is stopping (the user pressed Stop and sent at once) waits for the stop
   * to land and is sent once more. Any other refusal is thrown as it came.
   */
  async function send(
    args: SendArgs & { threadId: string },
    signal: AbortSignal | undefined,
  ): Promise<{ threadId: string; runId: string }> {
    try {
      return await convex.mutation(api.send, args);
    } catch (error) {
      const failure = toAgentError(error);
      if (!(failure instanceof AgentError) || failure.code !== "thread_busy") throw error;
      if (!(await stopLanded(args.threadId, signal))) throw error;
      return await convex.mutation(api.send, args);
    }
  }

  async function* runStream(
    threadId: string,
    runId: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamChunk> {
    let watching: ThreadWatch | null = null;
    const chunks = new RunChunks(threadId, runId, { thread: () => watching?.current() });
    yield chunks.started();
    const watch = watchThread(convex, api.thread, threadArgs(threadId));
    watching = watch;
    try {
      // Page actions run from the thread, once Hercules has delivered them: the
      // live stream below only shows them in the chat.
      watch.each(runPendingPageActions);
      // The run can be streamed once Hercules took it. It may also end first.
      const live = await watch.until(
        (thread) => (thread?.activeRun?.id === runId ? (thread.activeRun.live ?? undefined) : null),
        signal,
      );
      if (signal?.aborted) return;
      if (live !== undefined && live !== null) {
        // The stream is read until its final event, or until Convex has the
        // run's end, whichever comes first: a stream that stalls, or never
        // sends the ending, must not hold the chat while the reply is there.
        const stream = new AbortController();
        const stopStream = () => stream.abort();
        signal?.addEventListener("abort", stopStream, { once: true });
        void watch
          .until(
            (thread) => (thread === null || thread.activeRun?.id !== runId ? true : undefined),
            stream.signal,
          )
          .then(stopStream, stopStream);
        try {
          for await (const event of followRun({
            url: live.url,
            token: live.token,
            signal: stream.signal,
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            ...(options.retry !== undefined && { retry: options.retry }),
          })) {
            yield* chunks.apply(event);
          }
        } catch (error) {
          // The live view failed (Hercules refused the stream, or kept
          // answering 429 because too many tabs stream the run). The run did
          // not: Convex still gets it, so it is read from there.
          if (!(error instanceof RunStreamError)) throw error;
        } finally {
          signal?.removeEventListener("abort", stopStream);
          stream.abort();
        }
        if (signal?.aborted) return;
      }
      // Wait for Convex to have the run's end. With the end known from the
      // stream, not for long: a delivery that lags only delays the next message.
      const settled = await watch.until(
        (thread) => (thread === null || thread.activeRun?.id !== runId ? thread : undefined),
        signal,
        chunks.ending === null ? undefined : settleTimeoutMs,
      );
      if (signal?.aborted) return;
      yield* chunks.reconcile(settled);
      yield* chunks.finish(
        settled === null
          ? { status: "failed", error: { code: "not_found", message: "The thread was deleted." } }
          : undefined,
      );
    } finally {
      watch.stop();
    }
  }

  return {
    async *connect(messages, data, abortSignal, runContext) {
      const text = lastUserText(messages);
      if (text === null) {
        yield notSentChunk(runContext.threadId, runContext.runId, {
          code: "invalid_request",
          message: "There is no message to send.",
        });
        return;
      }
      const context = contextOf(data);
      let started: { threadId: string; runId: string };
      try {
        started = await send(
          { threadId: runContext.threadId, text, ...(context !== undefined && { context }) },
          abortSignal,
        );
      } catch (error) {
        const failure = toAgentError(error);
        // A run that never started ends here, with the reason's code on `chat.error`.
        yield notSentChunk(runContext.threadId, runContext.runId, {
          code: failure instanceof AgentError ? failure.code : "send_failed",
          message: failure.message,
        });
        return;
      }
      runThreads.set(started.runId, started.threadId);
      yield* runStream(started.threadId, started.runId, abortSignal);
    },

    async hydrate(threadId, hydrateOptions) {
      // The thread query reads the newest messages only; there are no older pages to load.
      if (hydrateOptions?.before !== undefined) {
        return { messages: [], activeRun: null, interrupts: null };
      }
      const thread = (await convex.query(
        api.thread,
        threadArgs(threadId, hydrateOptions?.limit),
      )) as ThreadValue;
      if (thread === null) return { messages: [], activeRun: null, interrupts: null };
      if (thread.activeRun !== null) runThreads.set(thread.activeRun.id, thread.id);
      // Page actions no tab has run yet, such as those sent while this page was closed.
      runPendingPageActions(thread);
      return {
        messages: threadToUIMessages(thread),
        activeRun: thread.activeRun === null ? null : { runId: thread.activeRun.id },
        interrupts: null,
      };
    },

    async *joinRun(runId, abortSignal) {
      const threadId = runThreads.get(runId);
      if (threadId === undefined) {
        throw new AgentError("not_found", "This page has not read the thread of that run.");
      }
      yield* runStream(threadId, runId, abortSignal);
    },

    async cancelRun({ threadId }) {
      if (api.cancel === undefined) return;
      await convex.mutation(api.cancel, { threadId });
    },

    setPageActions(next) {
      pageActions = next;
    },
  };
}

/**
 * Keeps the chat in step with the thread in Convex: a reply another tab or
 * device got shows here too, as far as Convex has it while it is written
 * (what Hercules has delivered of it, not the live stream) and whole once it
 * is done. It sets the chat's messages only while no reply is streaming on
 * this page. Returns the thread, for its `activeRun.progress` and
 * `latestRun`.
 *
 * ```tsx
 * const chat = useChat({ connection, threadId, persistence: true });
 * useThreadSync(chat, api.agent.thread, { threadId });
 * ```
 */
export function useThreadSync(
  chat: SyncableChat,
  thread: HerculesAgentApi["thread"],
  args: ThreadQueryArgs | "skip",
): AgentThread | null | undefined {
  const value = useQuery(thread, args) as ThreadValue | undefined;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const hydrating = chat.isHydrating === true;
  useEffect(() => {
    syncThread(chatRef.current, value);
  }, [value, hydrating]);
  return value;
}
