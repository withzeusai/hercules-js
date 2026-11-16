/* eslint-disable */
/**
 * Generated `ComponentApi` utility: the component as an app sees it.
 *
 * In the shape `npx convex codegen --component-dir src/component` writes.
 * That command needs a deployment, so these files are kept by hand: change
 * them with the functions, or regenerate them against a dev deployment.
 * `src/__tests__/component-api.test-d.ts` fails when this drifts from them.
 * @module
 */

import type { FunctionReference } from "convex/server";

type EndUser = { tokenIdentifier: string };
type Api = { key: string; url: string };
type MessagePart =
  | { text: string; type: "text" }
  | {
      id: string;
      kind: "hercules" | "app" | "page";
      name: string;
      status: "succeeded" | "failed" | "sent";
      summary: string | null;
      type: "tool_call";
    };
type Message = {
  created_at: string;
  id: string;
  parts: Array<MessagePart>;
  role: "user" | "assistant";
  run_id: string;
  thread_id: string;
};
type FinalRunStatus = "completed" | "failed" | "cancelled" | "capped";
type RunError = { code: string; message: string; retryAfterSeconds?: number };
type CappedReason = "steps" | "time" | "credits" | "output";
type Usage = { credits: number };
type WireEvent = {
  createdAt: string;
  data:
    | { kind: "none" }
    | { kind: "text"; messageId: string; text: string }
    | { kind: "message"; message: Message }
    | {
        kind: "tool_call";
        name: string;
        resultJson: string | null;
        status: "succeeded" | "failed" | "sent" | null;
        summary: string | null;
        toolCallId: string;
        toolKind: "hercules" | "app" | "page";
      }
    | { argumentsJson: string; kind: "page_action"; name: string; toolCallId: string }
    | { kind: "progress"; label: string }
    | {
        cappedReason: CappedReason | null;
        error: RunError | null;
        kind: "final";
        output: string | null;
        status: FinalRunStatus;
        usage: Usage | null;
      };
  runId: string;
  seq: number;
  threadId: string;
  type: string;
};
type Thread = {
  activeRun: {
    created_at: string;
    id: string;
    lastSeq: number;
    live: { token: string; url: string } | null;
    progress: string | null;
    status: "queued" | "running";
  } | null;
  agentId: string;
  hasMore: boolean;
  latestRun: {
    cappedReason: CappedReason | null;
    error: RunError | null;
    finished_at: string | null;
    id: string;
    status: "queued" | "running" | FinalRunStatus;
  } | null;
  id: string;
  messages: Array<{
    created_at: string;
    id: string;
    parts: Array<MessagePart>;
    role: "user" | "assistant";
    run_id: string;
    status: "streaming" | "completed" | "incomplete";
    thread_id: string;
  }>;
  pageActions: Array<{
    argumentsJson: string;
    created_at: string;
    name: string;
    runId: string;
    status: "pending" | "expired";
    toolCallId: string;
  }>;
};

type ThreadDetails = {
  activeRun: Thread["activeRun"];
  agentId: string;
  hasMore: boolean;
  id: string;
  latestRun: Thread["latestRun"];
  messages: Thread["messages"];
  pageActions: Thread["pageActions"];
  toolCalls: Array<{
    argumentsJson: string | null;
    created_at: string;
    kind: "hercules" | "app" | "page";
    name: string;
    resultJson: string | null;
    runId: string;
    status: "succeeded" | "failed" | "sent" | null;
    summary: string | null;
    toolCallId: string;
  }>;
  toolCallsTruncated: boolean;
};

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.herculesAgents`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.threads.read, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  events: {
    apply: FunctionReference<
      "mutation",
      "internal",
      { events: Array<WireEvent> },
      { applied: number; skipped: number },
      Name
    >;
  };
  threads: {
    cancel: FunctionReference<
      "mutation",
      "internal",
      { agentId: string; api: Api; owner: string; threadId: string },
      boolean,
      Name
    >;
    claimPageAction: FunctionReference<
      "mutation",
      "internal",
      { agentId: string; owner: string; runId: string; threadId: string; toolCallId: string },
      boolean,
      Name
    >;
    read: FunctionReference<
      "query",
      "internal",
      {
        agentId: string;
        exposeToolDetails?: boolean;
        limit?: number;
        owner: string;
        threadId: string;
      },
      Thread | null,
      Name
    >;
    readDetails: FunctionReference<
      "query",
      "internal",
      { agentId: string; limit?: number; threadId: string },
      ThreadDetails | null,
      Name
    >;
    remove: FunctionReference<
      "mutation",
      "internal",
      { agentId: string; api: Api; owner: string; threadId: string },
      boolean,
      Name
    >;
    send: FunctionReference<
      "mutation",
      "internal",
      {
        agentId: string;
        api: Api;
        context?: Record<string, any>;
        endUser: EndUser | null;
        exposeToolDetails?: boolean;
        onRunFinished?: string;
        pageActions?: Array<string>;
        runsPerHour?: number;
        text: string;
        threadId?: string;
      },
      | { ok: true; runId: string; threadId: string }
      | { code: string; message: string; ok: false; retryAfterSeconds?: number },
      Name
    >;
  };
};
