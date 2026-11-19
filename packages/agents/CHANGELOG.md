# @usehercules/agents

## 0.3.0

### Minor Changes

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - A tool that lists `"agent"` in `principals` now takes a call with no end user only from the app's own job, unless it says otherwise.

  - **Breaking for a tool that lists `"agent"` and is called by anything but the app's own job.** Hercules signs where a run with no end user was started into its tokens, as the claim `hercules_origin`: `app` (the app's own backend started the run with its app key and no end user), `organization`, `console`, `trigger`, `channel`, `schedule` or `test`. A tool that lists `"agent"` used to take every one of them. It now takes `app` alone. A call whose token names another origin, an origin the package does not know, or no origin at all is refused, and the tool is not listed to that caller. The package is not at 1.0 and Hercules apps pin its exact version, so this ships as a minor version.
  - **To keep the old behavior for a tool, add one line to it: `agentOrigins: "any"`.** To take only some origins, list them: `agentOrigins: ["app", "schedule"]`.
  - `agentOrigins` is only for a tool that lists `"agent"`. On any other tool it is a type error, and `defineTools` throws when the module loads. An empty list throws too.
  - The `agent` caller a handler receives has a new field, `origin`: the origin Hercules signed, or `null` when the token names none. `AgentOrigin` is its type.
  - A signed-in user's calls are not affected, with an agent acting for them or not.
  - An inspection listing carries each agent tool's origins beside its principals, under `hercules.app/agent-origins`.

### Patch Changes

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Name the package and its version on every request the app's backend makes to Hercules, in a `Hercules-Client: agents/<version>` header beside `Hercules-Version`: starting a run, reading it and its events, cancelling it, and deleting a thread. The version is the one in the package's `package.json`, written in by the build. The page's request for a run's live stream does not carry the header yet.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Reserve the error code `client_upgrade_required`, for the day Hercules no longer takes requests from a version of this package. Hercules does not send it today.

  - A start answered with it fails the run at once, with that code, and is not sent again, whatever HTTP status carries it (426 or 400).
  - A run that was going is failed the first time Hercules answers for it with the code, and a deleted thread is no longer asked about.
  - The run's stored error, the Convex log and `onRunFinished` tell the developer to upgrade `@usehercules/agents`, with what Hercules said. The thread a page reads carries the same code with "The assistant is not available right now.", as for `hercules_auth_required`.
  - `followRun` throws a `RunStreamError` with the code at once, as for any refusal.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - The README has a "Compatibility" section: what the package promises to do with event types, fields, statuses, part types and error codes the API adds after an app was built, and that a run can stay unfinished for a long time.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Name the end user on every request the component makes to Hercules about a user's thread or run, not only on the request that starts the run.

  - Reading a run, reading its events, stopping it, and deleting its thread now carry a `Hercules-End-User` header with the user's `tokenIdentifier`, the same string a run is started with as `end_user.token_identifier`. Starting a run carries it too, beside the body.
  - The identifier is the one the component stored when the thread was opened, never one a page sent. Requests about the app's own threads, those `run` opens, carry no such header.
  - An identifier a header cannot carry as it is (characters outside visible ASCII) is sent as `UTF-8''` followed by its percent-encoded UTF-8.
  - A 404 on any of these requests is handled as before.

  The component's `deleted_threads` table gains one optional field, `owner`, so a deleted thread's user is still known when Hercules is asked to delete it. A thread deleted before the upgrade is asked about without the header. No stored document changes shape and no function's arguments change.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Handle an answer from Hercules by its HTTP status when the package has no rule for its code, and add the code `agent_unavailable`.

  - `agent_unavailable` (403) fails a run at once and is not sent again. It is the app's setup: the agent is turned off, is not open to apps, has no owner, or its organization is suspended. The run's stored error tells the developer what to check, with what Hercules said, and the thread a page reads carries the code with "The assistant is not available right now." The codes Hercules used for the four cases before (`agent_not_exposed`, `organization_suspended`, `agent_disabled`, `agent_has_no_owner`) are read the same, and stored as `agent_unavailable`, so an app has one code to handle.
  - A code the package does not know is handled by its status: a 4xx other than 408 and 429 is final, a 408 or a 5xx is sent again, and a 429 is sent again once `Retry-After` is over, eight times at most. A 429 with a code the package does not know used to be final. `end_user_rate_limited` and `agent_daily_limit_reached` are still final: they are quotas.
  - A delete Hercules refuses with any 4xx other than 404, 408, 429 and a 409 `thread_busy` is not asked for again. It used to be asked for a day unless the status was 400, 401 or 403.
  - A run whose read Hercules refuses with a 4xx (after the app key was rotated, say) is asked about less and less often, up to every half hour, where it was asked every three minutes. The run stays open for delivery to settle.
  - `followRun` connects again after any 5xx, not only 500, 502, 503 and 504.
  - The README has a table of what the package does with each answer to a start.

  The codes Hercules answered before it reduced its list (`invalid_api_version`, `invalid_authorization`, `unsupported_content`, `credential_required`) are handled as they were: each is a 4xx, and fails the run with Hercules's code and message. A start is taken on a 202 and on a 200 alike. The package never sent `wait_seconds`.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Read what the API adds later without dropping what is known, in the app's backend and in the page.

  - A tool call of a kind the package does not know is kept, as a `hercules` tool call: the kind whose name and summary a page is not shown unless the app set `exposeToolDetails`. It used to be left out of its message, and its `tool_call.completed` was not stored.
  - A tool call that ended with a status the package does not know is kept, with the status `failed`: it is not known to have worked. It used to be left out of its message.
  - The events `followRun`, `useAgentThread` and `herculesConnection` read from a run's live stream are now read as the delivered ones are. A completed message holds only parts of the types the package knows, so a part type added later is no longer taken for a tool call. A `run.failed` always carries an `error`, and a `run.capped` with a reason the package does not know carries `capped_reason: null` (its type is now `CappedReason | null`). Fields the package does not know are passed on as they came.
  - `followRun` resumes after an event of a type it does not know, follows a run that is quiet for a long time without counting the streams Hercules closes as failures, and passes a finished run's reply on once however often Hercules sends it again.
  - An event of a type the package does not know that Hercules marks with `final: true` ends its run, here as `failed` with the code `run_failed` and with what the run wrote. No event carries the mark today.
  - A `run.progress` label, an error message and an error code are cut to a length a document can hold.

- [#254](https://github.com/withzeusai/hercules-js/pull/254) [`cabf04f`](https://github.com/withzeusai/hercules-js/commit/cabf04f4d8d442f867956faf07d390a9b3241aa2) Thanks [@grant0417](https://github.com/grant0417)! - Treat a run status the package does not know as a run that is still going.

  - The statuses a run ends with are a closed list: `completed`, `failed`, `cancelled`, `capped`. Every other status, one added to the API later among them, is a run that is going. It used to read as over, and a run read with such a status could not be read at all.
  - `isFinalStatus` takes any string, and is true only for those four.
  - A run in a status the package does not know keeps its thread's `activeRun`, with `status: "running"`, so a page shows it as going and can stop it. `onRunFinished` is not called for it, and `send` on its thread throws `thread_busy`, as for any run that is going.
  - A run is kept open for as long as Hercules answers that it is going, and is looked at every half hour at most. It used to be failed, and stopped at Hercules, a day after it was sent. A run is now failed only once nothing was heard of it for a day (no event delivered, and no answer that it is going), or a day after it was sent when it was asked to stop.
  - A run Hercules reports with a status the package does not know and a `finished_at` has ended: it is recorded as `failed` with the code `run_failed` (or the run's own error), and keeps the reply it wrote.
  - A thread deleted before its first start was answered is still deleted at Hercules when that run reads with a status the package does not know.

  The component's `runs` table gains one optional field, `goingAt`. No stored document changes shape and no function's arguments change, so an app on 0.2.0 upgrades with a plain deploy.

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
