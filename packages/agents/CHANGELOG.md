# @usehercules/agents

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
