# Events, limits and errors

What a run's events are as the package hands them to an app's code, the
`Run` object, when a run is over, what a stopped run keeps, the limits an
app meets and the error codes it reads, and what happens to a run's events
while the app is down.

The events and the `Run` are the Hercules API's own objects. The package
hands them on as Hercules sent them, under the API's names (snake_case), so
this guide describes them. It does not describe the requests the package
makes to Hercules: the package is the supported way to use the API, and
those requests are not part of its public API.

The [README](../README.md) is the reference: every export, option, default
and limit, and what the package promises under "Versioning". This guide adds
no promise of its own. Where it describes what Hercules does, that is for
context, and is Hercules's to define.

The other guides: [The Convex side](./convex.md), [The chat](./chat.md) and
[App tools](./tools.md).

## Where an app meets a run's events

Everything a run does is an event: it starts, text streams in, a tool is
called, the run ends.

- **In the page**, `followRun` yields each event of a run's live stream.
  `herculesConnection` and `useAgentThread` use it for you.
- **In the backend**, Hercules delivers the run's durable events to the route
  `support.registerRoutes(http)` serves, and the component applies them to
  the thread. An app's code does not handle them one by one: it reads what
  they made with `thread` and `readThreadDetails`, and is told of the run's
  end with `onRunFinished`.

## An event

An `AgentEvent`, as `followRun` yields it:

```json
{
  "id": "01JDX4M2...:42",
  "seq": 42,
  "run_id": "01JDX4M2...",
  "thread_id": "01JDX4M1...",
  "type": "run.progress",
  "final": false,
  "created_at": "2026-11-15T10:00:08.000Z",
  "data": { "label": "Checking the order" }
}
```

| Field                 | What it is                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `id`                  | `<run_id>:<seq>`. No two events share one                                                   |
| `seq`                 | The event's place in its run: a whole number, at least 1                                    |
| `run_id`, `thread_id` | The run, and its thread                                                                     |
| `type`                | What happened: see "The event types". An open set                                           |
| `final`               | Whether the event ends its run: `true` on the run's final event, and `false` on every other |
| `created_at`          | When it happened, as an ISO 8601 time in UTC                                                |
| `data`                | What the type carries                                                                       |

- No two events of a run share a `seq`, and an event that happens later has
  a higher one. Numbers are skipped, sometimes by many, so use `seq` to order
  events and as `followRun`'s `after`, never to count them. 0 is "from the
  start".
- Check `final`, not the type, to know that a run is over. An ending of a
  type added later is then still an ending.
- `followRun` hands on every field Hercules sent, known to this version or
  not, and yields each event once.

## The event types

| Type                  | Reaches                | `data`                                                                                    |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `run.queued`          | The stream and the app | `{}`. Every run's first event                                                             |
| `run.started`         | The stream and the app | `{}`                                                                                      |
| `message.delta`       | The stream only        | `{ message_id, text }`: the next piece of the reply                                       |
| `message.appended`    | Both, at best effort   | `{ message_id, text }`: the text written since the last one                               |
| `message.completed`   | The stream and the app | `{ message }`: the whole `Message`                                                        |
| `tool_call.started`   | The stream only        | `{ tool_call_id, name, kind }`                                                            |
| `tool_call.completed` | The stream and the app | `{ tool_call_id, name, kind, status, summary }`, and `result` for an app tool that worked |
| `page_action`         | The stream and the app | `{ tool_call_id, name, arguments }`                                                       |
| `run.progress`        | The stream and the app | `{ label }`: what the agent is doing, when no tool call says it                           |
| `run.completed`       | The stream and the app | `{ output, usage }`                                                                       |
| `run.failed`          | The stream and the app | `{ error, usage }`                                                                        |
| `run.cancelled`       | The stream and the app | `{ usage }`                                                                               |
| `run.capped`          | The stream and the app | `{ capped_reason, output, usage }`                                                        |

- An event that reaches the app is durable: Hercules keeps it with the run
  and delivers it to the app's backend. The two that reach the stream only
  are live: they are for a page that is watching, and are never delivered.
- `message.appended` is best effort. It lets the thread show a reply in
  steps while it is written, and is no longer sent once the run has stored
  the whole reply: a short reply may reach the app with none.
- `message.completed` is sent only when the run stored a reply. A stopped
  run stores the reply as far as it was written. A run that fails before it
  stores one, or is stopped before it writes any text, ends without one, so
  do not wait for it after a `message.delta`. When it comes, it is the reply
  as it stands, and replaces whatever the deltas built.
- A reply's text can repeat on the stream. When the agent has to write a
  step again, the step's `message.delta` events come a second time under
  the same `message_id`.
- `usage`, `error`, `output` and `capped_reason` are the run's: see "The Run
  object".
- Hercules may add event types, final ones among them. Skip one you do not
  know, unless its `final` is `true`: that event ended the run.

A `Message`, inside a `message.completed`:

```json
{
  "id": "01JDY0B7...",
  "thread_id": "01JDX4M1...",
  "run_id": "01JDX4M2...",
  "role": "assistant",
  "parts": [
    {
      "type": "tool_call",
      "id": "call_...",
      "name": "lookup_order",
      "kind": "app",
      "status": "succeeded",
      "summary": "Ran lookup order"
    },
    { "type": "text", "text": "Your order shipped on Tuesday." }
  ],
  "created_at": "2026-11-15T10:00:08.000Z"
}
```

- `role` is `user` or `assistant`. A part's `type` is `text` or `tool_call`.
- A tool call's `kind` is `hercules` (a tool that runs inside Hercules, a
  connector among them), `app` (one of the app's own tools) or `page` (a
  page action).
- Its `status` is `succeeded` or `failed`, or `sent` for a page action that
  went to the page.
- Its `summary` is one generic line to show in place of the details, made
  from the tool's name: "Ran lookup order", "Couldn't run lookup order" or
  "Sent open order to the page". It never describes the arguments or the
  result.
- A message never carries a tool's arguments or its result.
- All four sets are open: "Open sets" in the README says what a value you do
  not know means. A thread's message, `ThreadMessage`, has the same `parts`
  under the package's own field names.

## Tool calls and page actions

- `tool_call.completed` carries `result` only for one of the app's own tools
  that worked: what the tool returned. It is left out for a call that
  failed, for Hercules's own tools and for page actions.
- The arguments and results of Hercules's own tools never leave Hercules.
- A page's stream hides tool details unless the backend set
  `exposeToolDetails`: see "What the page sees of tools" in the README. The
  events Hercules delivers to the app's backend always carry them.
- A page action is one-way. When the agent calls one, a `page_action` event
  carries the arguments, the call completes at once with the status `sent`,
  and the run carries on. Nothing goes back to the run.
- Hercules checks a page action's arguments against the JSON Schema the
  agent declares for it. A call that does not match is not sent: there is no
  `page_action` event, and its `tool_call.completed` has the status
  `failed`. Arguments that pass arrive exactly as the agent wrote them, and
  are still untrusted input.
- Current behavior of Hercules, which may change: a `result` over 32,000
  characters of JSON arrives as `{ "truncated": true, "preview": "..." }`.

## When a run is over

When an event's `final` is `true`, or when the run's status is one of the
four a run ends with: `completed`, `failed`, `cancelled` and `capped`.

- Every run ends with exactly one final event: `run.completed`,
  `run.failed`, `run.cancelled` or `run.capped` today.
- Any other status is a run that is still going, one this version does not
  know among them.
- A run can stay unfinished for a long time, while it waits for a person
  say. Do not give up on a run because of how long it has been going.
- A run whose execution is lost is ended by Hercules as `failed`, with the
  code `run_failed`. So every run reaches an end, and its thread is free for
  the next run.
- A stream can close before the run's final event. That is not the run's
  end: `followRun` connects again and picks the run up where it stopped.

## Following a run with followRun

`followRun` reads a run's live stream with the `live` URL and token the
thread gives in `activeRun.live`. It connects again when the stream drops,
and ends after the run's final event, which it yields like any other.

<!-- sample: src/lib/read-reply.ts -->

```ts
// src/lib/read-reply.ts
import { followRun } from "@usehercules/agents";

// `live` is the thread's `activeRun.live`: the run's URL and its read-only token.
export async function readReply(live: { url: string; token: string }) {
  let text = "";
  for await (const event of followRun({ url: live.url, token: live.token })) {
    if (event.type === "message.delta") text += event.data.text;
    if (event.type === "message.completed") {
      // The whole reply: it replaces the text the deltas built.
      text = event.data.message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    }
  }
  return text;
}
```

A `switch` over `event.type` needs a `default`: the set is open.

<!-- sample: src/lib/watch-run.ts -->

```ts
// src/lib/watch-run.ts
import { followRun, RunStreamError, type AgentEvent } from "@usehercules/agents";

/** One line to show for an event, or null for one this page says nothing of. */
function lineFor(event: AgentEvent): string | null {
  switch (event.type) {
    case "run.progress":
      return event.data.label;
    case "tool_call.completed":
      return event.data.summary;
    case "run.failed":
      return `Failed: ${event.data.error.code}`;
    case "run.capped":
      return `Stopped at a limit: ${event.data.capped_reason ?? "not named"}`;
    default:
      // The types this page does not show, and any type added later. Check
      // `final`, not the type: an ending of a type added later still ends the run.
      return event.final ? `Ended: ${String(event.type)}` : null;
  }
}

export async function watchRun(
  live: { url: string; token: string },
  show: (line: string) => void,
  signal?: AbortSignal,
) {
  try {
    for await (const event of followRun({ url: live.url, token: live.token, signal })) {
      const line = lineFor(event);
      if (line !== null) show(line);
    }
  } catch (error) {
    // The live view failed, not the run: the reply still reaches the app's thread.
    if (!(error instanceof RunStreamError)) throw error;
  }
}
```

| Option   | What it is                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `url`    | The run's live URL: `activeRun.live.url`                                                                   |
| `token`  | The token that comes with it: `activeRun.live.token`. It reads that one run, and is safe in a browser      |
| `after`  | Yield the events after this `seq`. 0, the default, reads the run from its start                            |
| `signal` | An `AbortSignal` that ends the following                                                                   |
| `retry`  | How it connects again: the first wait and the longest, in milliseconds, and how many failed tries in a row |
| `fetch`  | The `fetch` to use                                                                                         |

- It throws a `RunStreamError` when Hercules refuses the stream, and after
  `retry.maxAttempts` failed connections in a row. Its `status` and `code`
  are the last answer's: 429 and `rate_limited` when all the streams
  Hercules allows of one run stayed taken, ten at this release.
- The error is about the live view, not the run. The run carries on, and its
  reply still reaches the app's thread.
- A run that is quiet for a long time is followed for as long as it takes.
- The stream has the live events until an hour after the run ends. After
  that the run's token no longer works. Deleting the run's thread ends its
  stream, and the token is refused from then on.
- `herculesConnection` and `useAgentThread` call `followRun` for you, and
  read the reply from Convex when the stream cannot be read.

## The Run object

A run as the Hercules API returns it. The package exports its type, `Run`.
The thread's `latestRun` and `onRunFinished` give an app the same run under
the package's own field names (`cappedReason`, `finishedAt`).

```json
{
  "id": "01JDX4M2...",
  "thread_id": "01JDX4M1...",
  "agent_id": "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  "status": "completed",
  "output": "Your order shipped on Tuesday and arrives Friday.",
  "error": null,
  "capped_reason": null,
  "usage": { "credits": 1.25 },
  "created_at": "2026-11-15T10:00:00.000Z",
  "finished_at": "2026-11-15T10:00:09.000Z"
}
```

| Field           | What it is                                                                                |
| --------------- | ----------------------------------------------------------------------------------------- |
| `status`        | `queued`, `running`, `completed`, `failed`, `cancelled` or `capped`. An open set          |
| `output`        | The agent's final reply as text. `null` while the run is going, or when it wrote none     |
| `error`         | `{ code, message }` when the run failed. See "Error codes"                                |
| `capped_reason` | Which limit stopped a `capped` run: `steps`, `time`, `credits` or `output`. An open set   |
| `usage`         | `{ credits }`: what the run spent, in the organization's AI credits. `null` while it runs |
| `created_at`    | When the run was started                                                                  |
| `finished_at`   | When the run ended. Set on every run that is over, and `null` on every run that is not    |

- `error.message` is written for developers. Do not show it to the app's
  users.
- A `capped_reason` of `steps`, `time` or `credits` is one of the agent's own
  limits, which its owner sets in Hercules. `output` is not a setting: the
  reply reached the most text one reply can hold, and the run stopped there
  with what it had written. Ask for a shorter answer, or for the rest in the
  thread's next message.
- An `error.code` you do not know still means the run failed, and a
  `capped_reason` you do not know still means a limit was reached.

## What a stopped run keeps

`cancel` asks Hercules to stop the run. A stopped run keeps what it wrote
before the stop:

- The reply is kept as far as it was written, so it can end in the middle of
  a sentence. The run's `output` holds its text, the thread holds it as a
  `completed` message, and the agent reads it on the thread's next run.
- Tool calls that returned before the stop are kept with it. A tool call
  still running at the stop is not.
- `output` is `null`, and the thread has no reply for the run, when it was
  stopped before it wrote any text.
- On the thread's next run the agent is told that this reply was stopped,
  and to leave the stopped request alone unless it is asked again.
- Text that one of the agent's guardrails was still checking at the stop was
  never sent, so it is not kept.
- The text of the step that was stopped is not charged.

The run ends as `cancelled`: `latestRun.status` and `onRunFinished` say so.
"How it works" in the README has what the component does while the run is
stopping.

## Limits

What stops a message or a run, who sets it, and what the app sees. The
values Hercules sets are as of this release, and are Hercules's to change.

| Limit                                   | Set by                                                                                     | What the app sees                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| A message's length                      | Hercules: 262,144 characters, for the text plus its `context`                              | `send` throws `message_too_long`, and nothing is written                                                                         |
| One run at a time on a thread           | Hercules and the package                                                                   | `send` throws `thread_busy` while a run is going                                                                                 |
| Runs per user per hour, in the app      | The app: `limits.runsPerUserPerHour`. No limit when left out                               | `send` throws `end_user_rate_limited` with `retryAfterSeconds`, and nothing is written                                           |
| Runs per user per hour, on the agent    | The agent's owner in Hercules: "Runs per user", 20 unless changed                          | The run fails at once with `end_user_rate_limited`, and `latestRun.error` has `retryAfterSeconds`                                |
| The agent's daily credit limit          | The agent's owner in Hercules: "Daily spend limit", 500 credits in 24 hours unless changed | The run fails at once with `agent_daily_limit_reached`, and `latestRun.error` has `retryAfterSeconds`                            |
| The organization's credits              | The organization's balance                                                                 | The run fails with `out_of_credits`                                                                                              |
| Runs an organization starts in a minute | Hercules: 60                                                                               | The package sends the run again after the wait Hercules names, a limited number of times, then the run fails with `rate_limited` |
| Live streams of one run at once         | Hercules: 10                                                                               | The chat hooks read the reply from Convex instead. `followRun` throws a `RunStreamError` after its tries                         |

- A message's length is counted as JavaScript's `length` counts it. Most
  characters count 1, and most emoji count 2. `context` is counted as
  Hercules writes it for the agent, which takes somewhat more than its
  compact JSON. A message within the limit reaches the agent whole.
- The two hourly limits are separate. The app's own is checked by `send`
  before anything is sent. The agent's is Hercules's, and a run refused over
  it fails like any other run. Both apply to runs for a signed-in user, and
  neither to a run the app starts with `run`.
- The daily credit limit applies to every run the app starts, `run`'s among
  them. It counts what the agent spent in the last 24 hours on threads apps
  opened, and is checked when a run starts: a run already going is not
  stopped when the limit is reached.
- For a run that failed over a limit, `retryAfterSeconds` counts from
  `latestRun.finishedAt`:

<!-- sample: src/lib/limit-ends-at.ts -->

```ts
// src/lib/limit-ends-at.ts
import type { AgentThread } from "@usehercules/agents/react";

/** When the limit that failed the thread's latest run is over, or null when no limit did. */
export function limitEndsAt(thread: AgentThread | null | undefined): Date | null {
  const run = thread?.latestRun ?? null;
  if (run === null || run.status !== "failed" || run.finishedAt === null) return null;
  const seconds = run.error?.retryAfterSeconds;
  if (seconds === undefined) return null;
  // `retryAfterSeconds` counts from when the run ended.
  return new Date(Date.parse(run.finishedAt) + seconds * 1000);
}
```

- How many messages one read of a thread returns, and how long a page action
  can be claimed, are under "Defaults and limits" in the README.

## Error codes

A `code` is any string: Hercules may add codes, so keep a default for one
you do not handle. "Error codes" in the README says which party writes each
code and where it shows. This is what to do about each.

When a message was not sent, `send` throws one of these, and the chat hooks
hand it to the page:

| Code                    | What happened                                                                               | What to do                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `sign_in_required`      | No one is signed in                                                                         | Sign the user in, and mount the chat once Convex knows who it is |
| `not_found`             | The thread is another user's or another agent's                                             | Start a new chat                                                 |
| `thread_deleted`        | The thread was deleted, and its id is retired                                               | Start a new chat under a new id                                  |
| `thread_busy`           | A run is still going on the thread, or a stopped run has not ended yet                      | Hold Send until `thread.activeRun` is `null`                     |
| `end_user_rate_limited` | The user reached `limits.runsPerUserPerHour`                                                | Say when they can send again, from `retryAfterSeconds`           |
| `message_too_long`      | The text and its context are over the limit                                                 | Ask for a shorter message, or send less `context`                |
| `invalid_request`       | The message is empty, or a new thread's id is not one made at random                        | Fix the page: send text, under a `crypto.randomUUID()`           |
| `send_failed`           | With TanStack: the app's `send` threw something that carries no code, a lost connection say | Let the user send again                                          |

When a run failed, the code is in `latestRun.error`, in `onRunFinished`, and
in the chat hooks' error. Nothing is thrown:

| Code                                | What happened                                                                                                    | What to do                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `run_failed`                        | Something stopped the run, or Hercules could not be reached to start it                                          | Let the user send again                                                                |
| `out_of_credits`                    | The organization has no AI credits left                                                                          | Do not send again. Add credits                                                         |
| `end_user_rate_limited`             | The user reached the agent's "Runs per user"                                                                     | Do not send again until `retryAfterSeconds` is over                                    |
| `agent_daily_limit_reached`         | The agent reached its "Daily spend limit"                                                                        | The same. Raise the limit on the agent if it is too low                                |
| `rate_limited`                      | The organization started runs too fast, and the wait did not clear it                                            | Let the user send again later                                                          |
| `thread_busy`                       | The thread's last run was still ending at Hercules                                                               | Let the user send again                                                                |
| `agent_not_found`                   | The app's setup: Hercules has no agent with this id for the app, or the agents API is not turned on for it       | Fix the `agentId` in `convex/agent.ts`. A new chat will not help                       |
| `agent_unavailable`                 | The app's setup: the agent is turned off, is not open to apps, has no owner, or its organization is suspended    | Check the agent in Hercules. The error the backend reads says what Hercules said       |
| `hercules_auth_required`            | The app's setup: the app has no Hercules Auth 2.0                                                                | Upgrade the app to Hercules Auth 2.0                                                   |
| `client_upgrade_required`           | The app's setup: Hercules no longer takes this version of the package. Reserved: Hercules does not send it today | Upgrade `@usehercules/agents`                                                          |
| `invalid_request`                   | The app's code: `pageActions` lists a name the agent does not declare, most often                                | Read the message in the backend, and fix the app                                       |
| `invalid_api_key`, `missing_scope`  | The app's setup: Hercules did not take the app's key                                                             | Check `HERCULES_API_KEY`, and leave the `apiKey` option unset in an app Hercules hosts |
| `http_<status>`, such as `http_403` | Hercules refused the run's start, and its answer named no code                                                   | Read the message in the backend                                                        |

- The codes marked as the app's setup or the app's code are not the user's to
  fix. A new chat will not help, so do not offer one: fix the app.
- For `agent_unavailable`, `hercules_auth_required` and
  `client_upgrade_required` the thread a page reads has a message for the
  user, "The assistant is not available right now.", and the backend reads
  what to do in `onRunFinished`, in `readThreadDetails` and in the Convex
  logs. Every other message is written for the developer.
- Hercules answers `client_upgrade_required` only to starting a run. An app
  on a version Hercules has retired starts nothing new, and can still stop
  its runs, show its threads and delete them.
- A failed live view is not a failed run. `RunStreamError.code` is Hercules's
  code for a stream it refused, such as `rate_limited`, or `null`: see
  "Following a run with followRun".
- `errorMessage` in [The chat](./chat.md#a-complete-chat) has words for the
  user for each.

## While the app is down

Hercules delivers a run's durable events to the Convex deployment whose key
started the run, so the app's database holds every message and the run's
result even when no one has the page open.

- **Delivery is in order within a thread, and at least once.** After a
  timeout the same events can arrive again. The component applies each event
  once, however often it is delivered.
- **Nothing is lost while the app cannot take a delivery.** The events stay
  with their runs at Hercules, which tries again, thread by thread, for up to
  24 hours from the thread's first failure.
- **A thread whose tries ran out goes again** when any delivery to the same
  deployment succeeds, or when the app is next published or deployed by
  Hercules.
- **A deployment that refuses every delivery**, one with no events route say,
  is asked again by Hercules by itself, less and less often. Nothing needs a
  deploy to recover: add the route, and the next try finds it. See "The
  events route" in the README.
- **The component also asks for itself.** When it has heard nothing of a run
  that is going for a while, it reads the run and its events from Hercules,
  and applies them. So a delivery that never arrives only delays a reply.
- **A thread left undelivered for a long time**, with no run going, is
  dropped from delivery. Its events stay with their runs.

Meanwhile a page that is open still streams the reply, since the stream is
between the browser and Hercules. The thread keeps its `activeRun` until the
app has the run's end, and `send` throws `thread_busy` until then.

## Ids

- Every id Hercules returns is an opaque string: an agent's, a run's, a
  thread's, a message's, a tool call's and an event's. Store and compare
  them as text. Do not parse one, check it against a pattern, or size a
  column to today's ids: what they look like, and how long they are, can
  change.
- The one exception is an event's `id`, which is `<run_id>:<seq>`.
- A new thread's id that the page chooses is a random UUID, as
  `crypto.randomUUID()` makes, or a ULID: see "Methods" in the README for the
  forms `send` takes. Left out, the package makes one.
- The package makes each run's id, and sends a run again under the same id,
  so a start that is sent twice never starts a second run.
- A deleted thread's id is retired: `send` under it throws `thread_deleted`.
