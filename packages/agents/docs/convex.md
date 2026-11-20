# The Convex side

How to run a Hercules agent from an app's Convex backend with
`@usehercules/agents/convex`: what the app needs, the functions the page
calls, what a thread holds, and what to do when a run ends.

The [README](../README.md) is the reference: every export, option, default
and limit, and what the package promises under "Versioning". This guide
shows how to use them and adds no promise of its own. Where it describes
what Hercules does, that is for context, and is Hercules's to define.

The other guides: [The chat](./chat.md), [App tools](./tools.md) and
[Events, limits and errors](./events-and-errors.md).

## What the app needs

- **The three files** under "Talking to an agent" in the README:
  `convex/convex.config.ts`, `convex/agent.ts` and `convex/http.ts`. In an
  app that already has a `convex/convex.config.ts` or a `convex/http.ts`,
  keep the file as it is and add the import and the one line
  (`app.use(herculesAgents)`, `support.registerRoutes(http)`).
- **The name `convex/agent.ts`.** The page passes `api.agent` to the chat,
  and the chat calls the functions by the names `support.api()` gives them.
- **Hercules Auth 2.0.** Hercules signs what it sends the app (a run's
  events, and the calls to the app's tools) with the app's own Hercules Auth.
  It starts no run for an app without it: the run fails at once with
  `hercules_auth_required`.
- **An agent that takes runs from apps.** The agent's id is the last part of
  the agent's address in the Hercules console. Copy it as it is. An agent
  that is turned off, or is not open to apps, fails every run with
  `agent_unavailable`.
- **Nothing to configure, in an app Hercules hosts.** `HERCULES_API_KEY`,
  `HERCULES_OIDC_AUTHORITY` and `CONVEX_SITE_URL` are set in every Convex
  deployment of the app. Leave the `apiKey`, `apiUrl` and `issuer` options
  unset, so the package reads them.
- **The events route.** Without `support.registerRoutes(http)` the app's
  backend does not hear when a run ends. A reply still reaches the database,
  but only when the component's own check asks Hercules about the run, long
  after the reply was written, and the next message in the thread fails with
  `thread_busy` until then.

## The functions the page calls

`support.api()` builds them, for the app to export from `convex/agent.ts`.
Each one acts for the signed-in user, and for that user's own threads.

| Function          | Kind     | Arguments                         | Returns                                                                                                      |
| ----------------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `send`            | mutation | `{ threadId?, text, context? }`   | `{ threadId, runId }`: the thread, new or not, and the run it started                                        |
| `thread`          | query    | `{ threadId, limit? }`            | The thread (see "What a thread holds"), or `null` when it is not this user's, not this agent's, or not there |
| `cancel`          | mutation | `{ threadId }`                    | `true` when there was a run to stop                                                                          |
| `claimPageAction` | mutation | `{ threadId, runId, toolCallId }` | `true` to the first tab that asks. `false` to every other, and for a page action that came too late          |
| `deleteThread`    | mutation | `{ threadId }`                    | `true` when there was a thread to delete                                                                     |

- Without a signed-in user, `send` throws `sign_in_required`, `thread`
  returns `null`, and the other three return `false`.
- Without `claimPageAction` among the exports, no page action runs.
- In an app with several `HerculesAgents`, each one's functions answer for
  its own threads only.

## Keeping a list of a user's chats

Neither the package nor Hercules lists a user's threads. To show a user their
past chats, save each new thread with the user. Export a `send` of your own in
place of the one from `support.api()`, with the same name and arguments, and
call `support.send` from it:

<!-- sample: convex/agent.ts -->

```ts
// convex/agent.ts
import { HerculesAgents } from "@usehercules/agents/convex";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { mutation } from "./_generated/server";

// Keep the `: HerculesAgents` annotation.
export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  onRunFinished: internal.orders.onAgentRunFinished,
  // Only names the agent declares.
  pageActions: ["open_order"],
});

export const { thread, cancel, claimPageAction, deleteThread } = support.api();

// `send`, with each new thread saved for the user who opened it.
export const send = mutation({
  args: {
    threadId: v.optional(v.string()),
    text: v.string(),
    context: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    // Throws `sign_in_required` when no one is signed in.
    const started = await support.send(ctx, args);
    const identity = await ctx.auth.getUserIdentity();
    const saved = await ctx.db
      .query("chats")
      .withIndex("by_thread", (q) => q.eq("threadId", started.threadId))
      .unique();
    if (saved === null && identity !== null) {
      await ctx.db.insert("chats", {
        threadId: started.threadId,
        tokenIdentifier: identity.tokenIdentifier,
        title: args.text.slice(0, 80),
      });
    }
    // The page needs the run's id: return what `support.send` returned.
    return started;
  },
});
```

<!-- sample: convex/chats.ts -->

```ts
// convex/chats.ts
import { query } from "./_generated/server";

// The signed-in user's chats, newest first.
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return [];
    return await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .order("desc")
      .take(50);
  },
});
```

- `chats` is a table of the app's own, with an index on `threadId` and one on
  `tokenIdentifier`.
- Keep the three arguments of `send` as they are: the chat calls it by name,
  and sends `context` with a message.
- A `send` that throws writes nothing: the mutation is one transaction.
- When a chat is deleted, delete its row in the mutation that calls
  `support.deleteThread`.

## What a thread holds

`thread` and `readThread` return an `AgentThread`, or `null`. The package
builds it, so its field names are camelCase.

| Field         | What it is                                                                       |
| ------------- | -------------------------------------------------------------------------------- |
| `id`          | The thread's id                                                                  |
| `agentId`     | The agent the thread belongs to                                                  |
| `messages`    | The thread's newest messages, oldest first: as many as `limit` says              |
| `hasMore`     | `true` when older messages were left out                                         |
| `activeRun`   | The run that is going, or `null`                                                 |
| `latestRun`   | The thread's latest run, going or not, or `null`: it says why a reply is missing |
| `pageActions` | The page actions no tab has run                                                  |

A message, `ThreadMessage`:

| Field               | What it is                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                | The message's id                                                                                                                     |
| `threadId`, `runId` | Its thread, and the run that it started (a user's message) or that wrote it (a reply)                                                |
| `role`              | `user` or `assistant`                                                                                                                |
| `parts`             | In order: `{ type: "text", text }`, or a tool call, `{ type: "tool_call", id, name, kind, status, summary }`                         |
| `createdAt`         | When it was written, as an ISO 8601 time in UTC                                                                                      |
| `status`            | `streaming` while the reply is being written, `completed`, or `incomplete` when its run ended and the app got only part of the reply |

The run that is going, `activeRun`:

| Field       | What it is                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `id`        | The run's id                                                                                             |
| `status`    | `queued` or `running`. A status the package does not know is a run that is going, and reads as `running` |
| `progress`  | The run's latest progress label, or `null`                                                               |
| `live`      | `{ url, token }` for the browser to stream the reply with, or `null` until Hercules has taken the run    |
| `lastSeq`   | The sequence number of the last event the app has applied                                                |
| `createdAt` | When the run was sent                                                                                    |
| `stopping`  | `true` once `cancel` asked for a stop, until the run has ended. `send` throws `thread_busy` until then   |

The latest run, `latestRun`:

| Field          | What it is                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`           | The run's id                                                                                                          |
| `status`       | `queued`, `running`, or one of the four a run ends with: `completed`, `failed`, `cancelled`, `capped`                 |
| `error`        | `{ code, message, retryAfterSeconds? }` for a failed run, otherwise `null`                                            |
| `cappedReason` | Which limit stopped a `capped` run: `steps`, `time`, `credits` or `output`. `null` for one this version does not know |
| `finishedAt`   | When the run ended, or `null` while it is going                                                                       |

A page action no tab has run, in `pageActions`:

| Field           | What it is                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `toolCallId`    | The call's id, which `claimPageAction` takes                                                        |
| `runId`         | The run that called it                                                                              |
| `name`          | The page action's name                                                                              |
| `argumentsJson` | Its arguments as JSON text. A model wrote them: untrusted input                                     |
| `createdAt`     | When the agent called it                                                                            |
| `status`        | `pending`: it waits for a tab to claim it. `expired`: it came too late, was not run and will not be |

- The reply of a run the user stopped is `completed`: Hercules sends it as
  far as it was written. See "What a stopped run keeps" in
  [Events, limits and errors](./events-and-errors.md#what-a-stopped-run-keeps).
- `latestRun.error.message` is written for the app's developer, in English.
  Show the user words of your own for the `code`. The exceptions are
  `agent_unavailable`, `hercules_auth_required` and `client_upgrade_required`,
  whose message in the thread a page reads is written for the user.
- For a run that failed over a limit, `latestRun.error.retryAfterSeconds`
  counts from `latestRun.finishedAt`.
- There is no cursor for older messages. A larger `limit`, up to the most one
  read returns, is the only way to read further back: see "Defaults and
  limits" in the README.
- Every status here is an open set: see "Open sets" in the README for what a
  value you do not know means.

## When a run ends

Pass `onRunFinished`, an internal mutation that takes
`runFinishedValidator.fields` as its arguments. The component calls it after
the run's last write, so it can read the finished messages from the thread:

<!-- sample: convex/orders.ts -->

```ts
// convex/orders.ts
import { runFinishedValidator } from "@usehercules/agents/convex";
import { internalMutation } from "./_generated/server";

export const onAgentRunFinished = internalMutation({
  args: runFinishedValidator.fields,
  handler: async (ctx, run) => {
    // run.status is "completed", "failed", "cancelled" or "capped".
    if (run.status !== "completed" || run.output === null) return;
    await ctx.db.insert("agentReplies", {
      threadId: run.threadId,
      runId: run.runId,
      reply: run.output,
      credits: run.usage?.credits ?? 0,
    });
  },
});
```

Here `agentReplies` is a table of the app's own. The function is called with a
`RunFinished`:

| Field                          | What it is                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `runId`, `threadId`, `agentId` | The run, its thread and its agent                                                                            |
| `status`                       | `completed`, `failed`, `cancelled` or `capped`, and no other                                                 |
| `output`                       | The run's reply as text, or `null` when it wrote none                                                        |
| `error`                        | `{ code, message, retryAfterSeconds? }` for a failed run, otherwise `null`. The message is for the developer |
| `cappedReason`                 | For a `capped` run, the limit that stopped it, or `null` for one this version does not know                  |
| `usage`                        | `{ credits }`: what the run cost, in the organization's AI credits. `null` when Hercules sent none           |
| `endUser`                      | `{ tokenIdentifier }`: the user the run was for. `null` for a run the app started with `run`                 |

## Running the agent with no user

Call `run` in a mutation or an action of the app's own, from a cron job say:

<!-- sample: convex/reports.ts -->

```ts
// convex/reports.ts
import { internalMutation } from "./_generated/server";
import { support } from "./agent";

// Internal: `run` checks no caller and no limit. Schedule it from a cron, say.
export const summarizeOrders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { threadId, runId } = await support.run(ctx, { text: "Summarize today's new orders." });
    return { threadId, runId };
  },
});
```

- The run acts for no end user, and its thread belongs to the app: no user
  can read it with `thread`. Read the reply in `onRunFinished`, where
  `endUser` is `null`, or with `readThreadDetails`.
- Of the app's own tools, the run can call only those that list the `"agent"`
  caller, and they read `caller.origin` as `"app"`. See
  [App tools](./tools.md).

## What the agent's tools did

A thread goes to the user's browser, so `thread` leaves out what the tools did
in detail: see "What the page sees of tools" in the README. The component
stores everything as delivered, and the app's backend reads it with
`readThreadDetails`, which returns the thread with `toolCalls`:

<!-- sample: convex/audit.ts -->

```ts
// convex/audit.ts
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { support } from "./agent";

// Internal: `readThreadDetails` answers for any user's thread.
export const toolCallsOf = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const details = await support.readThreadDetails(ctx, { threadId });
    return details?.toolCalls ?? [];
  },
});
```

Each tool call is a `StoredToolCall`:

| Field           | What it is                                                                     |
| --------------- | ------------------------------------------------------------------------------ |
| `toolCallId`    | The call's id                                                                  |
| `runId`         | The run that made it                                                           |
| `name`          | The tool's own name, a Hercules tool's among them                              |
| `kind`          | `hercules`, `app` or `page`                                                    |
| `status`        | `succeeded`, `failed`, or `sent` for a page action. `null` when none is stored |
| `summary`       | One line for the call, or `null`                                               |
| `resultJson`    | An app tool's result as JSON text. `null` for the other kinds                  |
| `argumentsJson` | A page action's arguments as JSON text. `null` for the other kinds             |
| `createdAt`     | When the call was made                                                         |

- `toolCalls` holds the calls of the runs whose messages are listed, oldest
  first. `toolCallsTruncated` is `true` when the results came to more than
  one read holds, and the older runs' calls were left out.
- The arguments and results of Hercules's own tools never leave Hercules, so
  such a call has a name and a summary only.
- `thread` and the two chat hooks never carry a tool's result, with
  `exposeToolDetails` on or off. With it on, the results of the app's tools
  travel to the browser on the run's live stream, where the user can read
  them. Turn it on only when every result is safe for the user to see.
- Current behavior of Hercules, which may change: a result over 32,000
  characters of JSON is delivered as `{ "truncated": true, "preview": "..." }`,
  and `resultJson` then holds that.

## Who a run acts for

- A run `send` starts acts for the user `ctx.auth` names, by their
  `tokenIdentifier` (`<issuer>|<subject>`). The package names that user to
  Hercules on every request about their thread.
- The app's own tools see that user only when the app's own Hercules Auth
  signed them in. See "Users another sign-in method signed in" in
  [App tools](./tools.md#users-another-sign-in-method-signed-in).
- A run `run` starts acts for no end user.

## Deleting a thread

"Deleting a thread" in the README says what `deleteThread` does. For the
page: `thread` reads `null` from then on, the live stream of a run still
going ends, and the thread's id is retired, so start the next chat under a
new id.

## Questions

**Why does the next message fail with `thread_busy`?** The app's backend has
not heard that the last run ended. Check that `convex/http.ts` calls
`support.registerRoutes(http)`. A run the user stopped also takes a moment
to end: `activeRun.stopping` is `true` until it has.

**Does it work with a custom domain on the Convex deployment?** Yes, while
`CONVEX_CLOUD_URL` is the one Convex set. See "The events route" in the
README.

**Does it work with a backend that is not Convex?** Not in this release.
`@usehercules/agents/convex` and the component are for Convex. The root
entry point, `@usehercules/agents`, holds what does not depend on Convex:
the types, and `followRun`.
