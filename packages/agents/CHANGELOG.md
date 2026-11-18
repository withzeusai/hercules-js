# @usehercules/agents

## 0.2.0

### Minor Changes

- [#249](https://github.com/withzeusai/hercules-js/pull/249) [`fb05c11`](https://github.com/withzeusai/hercules-js/commit/fb05c11d41d145916d15872366b0586116660403) Thanks [@grant0417](https://github.com/grant0417)! - Remove `visitorId` from the `agent` tool caller, give a run refused for want of Hercules Auth 2.0 a clear error, and keep a second tab in step with a run it did not start.

  - **Breaking for an app that reads `caller.visitorId`:** the field is gone from `ToolCaller`. Agents take no anonymous visitors, and the field was deprecated in 0.1.1. The package is not at 1.0 and Hercules apps pin its exact version, so this ships as a minor version. Delete the read: an `agent` caller has no end user. A token that still carries the `hercules_visitor` claim verifies as before and reads as that same `agent` caller.
  - A run Hercules refuses as `hercules_auth_required` (the app has no Hercules Auth 2.0 tenant, so Hercules cannot deliver the run's events to it or call its tools) fails at once and is not sent again. Its error tells the developer to upgrade the app to Hercules Auth 2.0: in the Convex logs, in `onRunFinished` and in `readThreadDetails`. The thread a page reads has the same code with the message "The assistant is not available right now." A code the package does not know still fails the run with the message Hercules sent.
  - `useThreadSync` follows a run another tab started through every update of the thread. It stopped after the first one: the message that started the run carries the run's id, which was taken to mean that this page streamed the run. What this page streamed is still left alone until Convex has the run's end.

### Patch Changes

- [#250](https://github.com/withzeusai/hercules-js/pull/250) [`ee477b8`](https://github.com/withzeusai/hercules-js/commit/ee477b8fffe65bed2cc02fddcc0fe6529326c077) Thanks [@grant0417](https://github.com/grant0417)! - Harden deleting a thread, the hourly limit, and page actions.

  - `deleteThread` asks Hercules to delete only a thread Hercules took a run on. Hercules takes a run only for the user it was sent for, so a run it took is what tells the component that the thread under that id at Hercules is the caller's. A thread whose runs Hercules all refused, or never got, is deleted in the app alone. One deleted while its first run is still being started is deleted at Hercules once Hercules says it has that run. A thread with a run Hercules took is deleted as before.
  - `limits.runsPerUserPerHour` holds across `deleteThread`. The runs of a deleted thread count until an hour after they were sent, where deleting the thread used to give them back.
  - A page action a run was not started with is dropped when Hercules delivers it, with a warning in the Convex logs, so no page lists or claims it. In the page, a handler runs only when it is a function the page set under that exact name: a name every object answers to, such as `constructor` or `toString`, finds none.
  - The README says what a page action handler may do with its arguments, which a model writes, and its examples check the id they navigate with. It names `run` and `readThreadDetails` as server-only: neither reads `ctx.auth`, and `support.api()` exports neither.

  The component's schema gains one table, `purged_run_starts`, and one optional field, `deleted_threads.unconfirmedRunId`. No stored document changes shape and no function's arguments change, so an app on 0.1.x upgrades with a plain deploy.

## 0.1.1

### Patch Changes

- [#248](https://github.com/withzeusai/hercules-js/pull/248) [`2944ae7`](https://github.com/withzeusai/hercules-js/commit/2944ae7f70795479a3efec7fd21c1a05d26c6df7) Thanks [@grant0417](https://github.com/grant0417)! - Make stopping a reply hold together.

  - A message sent right after `chat.stop()` is no longer refused as `thread_busy`: `herculesConnection` waits for the stopped run to end, for `settleTimeoutMs` at most, and then sends it. The thread says a stop is on its way with the new `activeRun.stopping`, for a page that would rather hold its Send button.
  - A stop that Hercules had not finished when it answered is asked for again within seconds, not at the stuck-run check three minutes later.
  - The reply a page streamed before a stop stays in the chat: `useThreadSync` keeps it, with `metadata.hercules.status` set to `"incomplete"`, when the thread holds less of it. The thread itself keeps the reply up to its last checkpoint: the component now reads what the run wrote before it records the stop, and a checkpoint delivered after the stop reads as `incomplete`, not as `streaming` for good.
  - A run that was asked to stop and that Hercules ends as `failed` with the code `run_failed` is recorded as `cancelled`, so a page does not report an error for a reply its user stopped.
  - `visitorId` on an `agent` tool caller is deprecated. Agents no longer take anonymous visitors; it is still set for a thread a visitor opened before that.

## 0.1.0

### Minor Changes

- [#242](https://github.com/withzeusai/hercules-js/pull/242) [`2abec3b`](https://github.com/withzeusai/hercules-js/commit/2abec3bb332f951b1a6e72535b4a1dd79994a3c2) Thanks [@grant0417](https://github.com/grant0417)! - Talk to a Hercules agent from a Convex app. `@usehercules/agents/convex.config` is a Convex component that keeps an agent's threads, runs and messages in the app's own deployment, and `HerculesAgents` in `@usehercules/agents/convex` starts runs from the app's mutations (`send`, `run`), reads a user's thread (`readThread`), and routes the events Hercules delivers (`registerRoutes`). `useAgentThread` in `@usehercules/agents/react` streams the reply live and runs page actions in one tab. Callers are signed-in users (`ctx.auth`); there are no anonymous visitors. A page sees Hercules tool calls as "tool" and no tool results unless the app sets `exposeToolDetails`, and the app's backend reads the full record with `readThreadDetails`. A page action that reaches the app more than two minutes late is not run and is listed on the thread as `expired`.

- [#235](https://github.com/withzeusai/hercules-js/pull/235) [`d1f8036`](https://github.com/withzeusai/hercules-js/commit/d1f8036fa6255def46111e63e9aab12b4c23d2bc) Thanks [@grant0417](https://github.com/grant0417)! - Add `@usehercules/agents`: serve an app's tools to Hercules agents. `@usehercules/agents/convex` declares tools with Convex validators (`defineTools`, `tool`) and routes them from `convex/http.ts` as an MCP server. The package verifies Hercules Auth tokens itself and hands each tool the verified caller, so a token for the tools is not accepted by the app's other functions.

- [#243](https://github.com/withzeusai/hercules-js/pull/243) [`1e78d7c`](https://github.com/withzeusai/hercules-js/commit/1e78d7c78e6f62490e540c4d94a2d0594db55e5f) Thanks [@grant0417](https://github.com/grant0417)! - Embed a Hercules agent's chat with TanStack AI. `herculesConnection` in `@usehercules/agents/tanstack` is a TanStack AI connection that sends through the app's Convex `send` mutation and streams the run's live events as AG-UI chunks, so `useChat` and the headless kit in `@tanstack/ai-react/ui` render the reply with the app's own components. With `persistence: true` the chat reads the thread from Convex on mount and joins a reply still being written; `useThreadSync` shows replies from other tabs. Page actions run in one tab and reach TanStack as tool calls with the result "sent to the page", so TanStack never starts a second run. `send` now also opens a thread under a new UUID or ULID the page chose, as a TanStack chat names its thread before the first message. A deleted thread's id is retired: `send` under it throws `thread_deleted`.
