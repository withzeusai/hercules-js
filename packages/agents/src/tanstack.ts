"use client";
/**
 * `@usehercules/agents/tanstack`: a Hercules agent behind TanStack AI's
 * `useChat`, in a Convex app. The page keeps TanStack's chat state and UI
 * kit; Convex keeps the thread.
 *
 * ```tsx
 * const connection = herculesConnection(convex, api.agent, {
 *   pageActions: { open_order: ({ orderId }) => navigate(`/orders/${orderId}`) },
 * });
 *
 * function Chat({ threadId }: { threadId: string }) {
 *   const chat = useChat({ connection, threadId, persistence: true });
 *   useThreadSync(chat, api.agent.thread, { threadId });
 * }
 * ```
 *
 * `threadId` is the page's: a UUID it makes for a new chat
 * (`crypto.randomUUID()`), and keeps, in the URL say. The first message
 * opens the thread under it.
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
import { notSentChunk, RunChunks, runIdOf, threadToUIMessages, transcriptKey } from "./ag-ui";
import type { AgentThread } from "./agents";
import { AgentError, toAgentError } from "./errors";
import { createPageActionRunner, type PageActionHandlers } from "./page-actions";
import { followRun, RunStreamError, type RunStreamOptions } from "./stream";

export {
  agentErrorCode,
  PAGE_ACTION_OUTPUT,
  PROGRESS_EVENT,
  threadToUIMessages,
  type HerculesMessageMetadata,
  type HerculesToolOutput,
} from "./ag-ui";
export type { PageActionHandler, PageActionHandlers } from "./page-actions";
export type { AgentThread } from "./agents";

export type SendArgs = {
  threadId?: string;
  text: string;
  context?: Record<string, any>;
};

export type ThreadQueryArgs = {
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

/** What the adapter needs of the app's Convex client: a `ConvexReactClient` has it. */
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
   * message would find the thread busy. Defaults to 10 seconds.
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
  /** Replaces the page's actions, for handlers that change with the page. */
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
  return {
    each(listener) {
      function check() {
        let thread: unknown;
        try {
          thread = watch.localQueryResult();
        } catch {
          // `until` reports a thread that cannot be read.
          return;
        }
        if (thread !== undefined) listener(thread as ThreadValue);
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
 * functions. Make it once, outside the component (`useChat` keeps the first
 * connection it gets for a thread):
 *
 * - `connect` sends the message with the app's `send` mutation, then streams
 *   the run's live events from Hercules as AG-UI chunks, resuming with
 *   `Last-Event-ID`. It ends once Convex has the run's end, so the next
 *   message never finds the thread busy.
 * - `hydrate` reads the thread once, for `persistence: true`.
 * - `joinRun` replays a run still going from its start, after a reload.
 * - `cancelRun` stops the run with the app's `cancel` mutation.
 *
 * Page actions are one-way: each comes to TanStack as a tool call with the
 * result "sent to the page", so TanStack never starts a run of its own, and
 * the adapter runs the page's handler.
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

  async function* runStream(
    threadId: string,
    runId: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamChunk> {
    const chunks = new RunChunks(threadId, runId);
    yield chunks.started();
    const watch = watchThread(convex, api.thread, threadArgs(threadId));
    // Page actions run from the thread, once Hercules has delivered them: the
    // live stream below only shows them in the chat.
    watch.each(runPendingPageActions);
    try {
      // The run can be streamed once Hercules took it. It may also end first.
      const live = await watch.until(
        (thread) => (thread?.activeRun?.id === runId ? (thread.activeRun.live ?? undefined) : null),
        signal,
      );
      if (signal?.aborted) return;
      if (live !== undefined && live !== null) {
        try {
          for await (const event of followRun({
            url: live.url,
            token: live.token,
            ...(signal !== undefined && { signal }),
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            ...(options.retry !== undefined && { retry: options.retry }),
          })) {
            yield* chunks.apply(event);
          }
        } catch (error) {
          // Hercules refused the stream; Convex still gets the run, so it is read from there.
          if (!(error instanceof RunStreamError)) throw error;
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
        started = await convex.mutation(api.send, {
          threadId: runContext.threadId,
          text,
          ...(context !== undefined && { context }),
        });
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

/** What `useThreadSync` needs of `useChat`'s result. */
export interface SyncableChat {
  readonly messages: ReadonlyArray<{
    id: string;
    role: string;
    parts: ReadonlyArray<unknown>;
    metadata?: Record<string, any> | undefined;
  }>;
  readonly isLoading: boolean;
  readonly isHydrating?: boolean;
  setMessages(messages: Array<UIMessage>): void;
}

/**
 * Puts the thread as Convex has it into the chat, when it reads differently
 * from what the chat shows and no reply is streaming here. Returns whether
 * it did. Messages older than the thread's window stay as they are.
 */
export function syncThread(chat: SyncableChat, thread: ThreadValue | undefined): boolean {
  if (thread === null || thread === undefined) return false;
  if (chat.isLoading || chat.isHydrating === true) return false;
  // This page streamed that run, and Convex has not caught up with it yet.
  const active = thread.activeRun?.id;
  if (active !== undefined && chat.messages.some((message) => runIdOf(message) === active)) {
    return false;
  }
  let next = threadToUIMessages(thread);
  const first = next[0];
  if (thread.hasMore && first !== undefined) {
    const index = chat.messages.findIndex((message) => message.id === first.id);
    if (index > 0) next = [...(chat.messages.slice(0, index) as UIMessage[]), ...next];
  }
  if (transcriptKey(next) === transcriptKey(chat.messages)) return false;
  chat.setMessages(next);
  return true;
}

/**
 * Keeps the chat in step with the thread in Convex: a reply another tab or
 * device got shows here too. It sets the chat's messages only while no reply
 * is streaming on this page. Returns the thread, for its `activeRun.progress`
 * and `latestRun`.
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
