# @usehercules/agents

Hercules agents in a Hercules app:

- **Talk to an agent** from a Convex app. The app's backend starts runs,
  Hercules delivers what they do into the app's own database, and the page
  streams the reply as it is written.
- **Serve the app's tools** to agents over MCP, with Hercules Auth deciding
  who is calling them.

The package has no runtime dependencies. It verifies tokens with Web Crypto,
so it fits in a Convex HTTP action. Convex, React and TanStack AI
(`@tanstack/ai` and `@tanstack/ai-client`) are optional peers, needed only by
the entry points that use them.

| Entry point                         | What                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `@usehercules/agents/convex.config` | The `herculesAgents` Convex component                               |
| `@usehercules/agents/convex`        | `HerculesAgents`, and `defineTools`, `tool`, `ToolError`            |
| `@usehercules/agents/tanstack`      | `herculesConnection` and `useThreadSync`, for TanStack AI's chat    |
| `@usehercules/agents/react`         | `useAgentThread`, a lighter chat hook with no TanStack              |
| `@usehercules/agents`               | Backend-neutral: API types, `followRun`, the token verifier and MCP |

## Talking to an agent

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import herculesAgents from "@usehercules/agents/convex.config";

const app = defineApp();
app.use(herculesAgents);
export default app;
```

```ts
// convex/agent.ts
import { HerculesAgents } from "@usehercules/agents/convex";
import { components, internal } from "./_generated/api";

// Keep the `: HerculesAgents` annotation.
export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T", // The agent's id, a ULID.
  onRunFinished: internal.orders.onAgentRunFinished,
  limits: { runsPerUserPerHour: 20 },
});

// send, thread, cancel, claimPageAction and deleteThread, for the page.
export const { send, thread, cancel, claimPageAction, deleteThread } = support.api();
```

The annotation on `support` is needed: `internal` is typed from every
module's exports, `support` included, so without it TypeScript cannot infer
`support` from an initializer that names `internal`, and the app's type-check
fails with TS7022.

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { support } from "./agent";

const http = httpRouter();
support.registerRoutes(http); // POST /hercules/agents/events
export default http;
```

To shape the functions yourself, call the methods from your own. Keep the
names and args `support.api()` gives them: the page's connection calls them
by name, and sends `context` with a message.

```ts
export const send = mutation({
  args: {
    threadId: v.optional(v.string()),
    text: v.string(),
    context: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const started = await support.send(ctx, args);
    // Save started.threadId with the user, to list their past chats, say.
    return started;
  },
});
export const thread = query({
  args: { threadId: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, args) => support.readThread(ctx, args),
});
```

### How it works

1. `send` runs in a mutation. It reads the signed-in user from `ctx.auth`,
   checks their hourly limit and that no run is going on the thread, writes
   their message and the run, and schedules the call that starts the run at
   Hercules with the app's `HERCULES_API_KEY`. All in one transaction.
2. Hercules delivers the run's events to `POST /hercules/agents/events`,
   signed by the app's Hercules Auth tenant. Each batch is applied in one
   mutation, and each event once. Streamed text is kept in chunks and merged
   when the message completes; a message too large for one document is
   stored in several.
3. The page reads the thread with `thread`, a Convex query, and streams the
   reply from Hercules with the run's read-only token.
4. When a run ends, `onRunFinished` is called after the last write.

Every request the component makes to Hercules about a user's thread or run
names that user: starting the run, reading it and its events, stopping it,
and deleting the thread. The name is the user's `tokenIdentifier`, as the
component stored it when the thread was opened from `ctx.auth`, never
anything a page sent, and it travels in a `Hercules-End-User` header.
Requests about the app's own threads, those `run` opens, name no one.

If nothing has been delivered for a run for a few minutes, the component asks
Hercules for the run and then its events itself, so a delivery that never
arrives only delays a reply. While Hercules says the run is still going it
asks less and less often, and any delivered event starts that over. Every
time and limit named in this README has its value in one place, "Defaults
and limits". The same check sends a run again if the call
that starts it was lost, asks again for a cancel that did not get through,
and records a run's ending only once every event before it is applied. The
check is started by a mutation that reschedules itself, which Convex never
loses, so a run is not left open and its thread busy behind a check that was
lost.

A run stays open for as long as Hercules says it is going, however long that
is: a status the package does not know reads as a run that is going, not as
one that ended. A run is failed, so its thread is free again, only once
nothing was heard of it for the give-up time: no event delivered, and no
answer from Hercules that it is still going. A run that was asked to stop is
failed that long after it was sent, whatever Hercules answers.

A start Hercules cannot answer is not a refusal. On a 503, any other 5xx, a
timeout or a network error the run stays open and is sent again under the
same id, as told by `Retry-After` and then further apart, until Hercules
answers with the run or refuses it: Hercules may have the run already, and
says so in the 503 it answers while it cannot confirm the run started. A run
it never takes is failed after the give-up time.

A run Hercules does not take fails with Hercules's own code, and with the
message Hercules sent unless the package has its own for the code. A code the
package does not know fails the run the same way, with that code. Some codes
are the app's setup, not the conversation, so a new chat will not help:

- `agent_not_found`: Hercules has no agent with the id in `convex/agent.ts`
  for this app, or the agents API is not turned on for it. Fix the id.
- `agent_unavailable`: Hercules will not run the agent for the app. The
  agent is turned off, is not open to apps, has no owner, or its
  organization is suspended. Check the agent in Hercules. The run fails at
  once and is not sent again. Its error tells the developer what to check,
  with what Hercules said, and the thread a page reads has the same code
  with "The assistant is not available right now."
- `hercules_auth_required`: the app has no Hercules Auth 2.0 tenant, so
  Hercules cannot deliver a run's events to it or call its tools. Upgrade the
  app to Hercules Auth 2.0. The run fails at once and is not sent again. Its
  error tells the developer to upgrade: in the Convex logs, in `onRunFinished`
  and in `readThreadDetails`. The thread a page reads has the same code with
  a message for its user: "The assistant is not available right now."
- `client_upgrade_required`: Hercules no longer takes requests from the
  version of `@usehercules/agents` the app runs. Upgrade the package. The run
  fails at once and is not sent again, and a run that was going is failed the
  first time Hercules answers for it with this code. The developer and the
  page read it as they read `hercules_auth_required`: the error tells the
  developer to upgrade, and the page's message is "The assistant is not
  available right now." Hercules does not send this code today. It is
  reserved, so that a version in use can be retired one day.

A run Hercules refuses over a limit (`end_user_rate_limited`,
`agent_daily_limit_reached`) fails at once with that code. The thread's
`latestRun.error` then carries `retryAfterSeconds`, counted from
`latestRun.finished_at`.

What the package does with an answer is decided by its code when the package
has a rule for it, and by its HTTP status otherwise. Hercules may add codes,
so a code the package does not know is handled by the status it came with:

| Hercules answers a start with                                 | The package                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 202, or 200                                                   | Takes the run. One that is already over is settled at once, with what it wrote                           |
| 404                                                           | Fails the run as `agent_not_found`. Not sent again                                                       |
| 403 `agent_unavailable`                                       | Fails the run with that code. Not sent again. The page reads "The assistant is not available right now." |
| 409 `hercules_auth_required`, 426 `client_upgrade_required`   | The same, with what the developer has to upgrade                                                         |
| 409 `thread_busy`                                             | Sends it again for the busy wait, then fails the run as `thread_busy`                                    |
| 429 `end_user_rate_limited`, `agent_daily_limit_reached`      | Fails the run with that code and `retryAfterSeconds`. Not sent again                                     |
| 429 with any other code, or none                              | Sends it again once `Retry-After` is over, up to the rate-limit tries, then fails the run with that code |
| 408, any 5xx, or no answer                                    | Sends it again under the same run id, as `Retry-After` says and then further apart, for the give-up time |
| Any other 4xx, with any code: 400, 401, 402, 403, 409, 413... | Fails the run with Hercules's code and message. Not sent again                                           |

The other requests follow the same rule. A delete Hercules refuses with a 4xx
is not asked for again, except a 404 (which has to stay the answer for a
while: see "Deleting a thread") and a 409 `thread_busy` (the thread's run is
still stopping). A run
whose read is refused with a 4xx is left for delivery to settle, and is asked
about less and less often. `followRun` connects again after a 408, a 429 or a
5xx, and throws a `RunStreamError` on any other answer.

`cancel` asks Hercules to stop the run. Until Hercules has, the run is still
the thread's: `activeRun.stopping` is true, and `send` throws `thread_busy`.
That is a second or so as a rule. The component then reads what the run wrote
before it stopped and records the run as `cancelled`. A reply that was
stopped while it was written is kept as far as it was written: Hercules
delivers that text as the run's reply, and the thread holds it as a message
with the status `completed`. A run stopped before it wrote any text leaves no
reply. A message has the status `incomplete` only when its run ended and the
app got part of the reply, not the whole: a run that failed while it was
writing, say. A run that was asked to stop and that Hercules ends as `failed`
with the code `run_failed` is recorded as `cancelled` too; a failure with a
code of its own, such as `out_of_credits`, stays a failure.

### Methods

| Method                                                   | Where              | Does                                                                     |
| -------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `send(ctx, { threadId?, text, context?, pageActions? })` | mutation           | Sends the caller's message and starts a run                              |
| `run(ctx, { threadId?, text, context?, pageActions? })`  | mutation or action | Starts a run as the app's own job, for no end user                       |
| `readThread(ctx, { threadId, limit? })`                  | query              | The caller's thread: its newest messages, the run going, its live stream |
| `readThreadDetails(ctx, { threadId, limit? })`           | query, internal    | A thread as stored, with tool results. For the app's backend             |
| `cancel(ctx, { threadId })`                              | mutation           | Stops the run going on the caller's thread                               |
| `deleteThread(ctx, { threadId })`                        | mutation           | Deletes the thread here and at Hercules. Irreversible                    |
| `claimPageAction(ctx, { threadId, runId, toolCallId })`  | mutation           | Takes a page action for one tab to run                                   |
| `registerRoutes(http)`                                   | `convex/http.ts`   | Routes the events Hercules delivers. One route serves all agents         |

`pageActions` on `send` and `run` replaces the option's list for that one
run. The `send` that `support.api()` exports does not take it: a page does
not choose a run's page actions.

`run` and `readThreadDetails` are server-only. Neither reads `ctx.auth`: `run`
starts a run for no end user and against no limit, and `readThreadDetails`
returns any user's thread with its tool results. Call them from an internal
function (`internalMutation`, `internalQuery`, a cron), or from a public one
only after it has checked who is asking. `support.api()` exports neither, and
the package cannot tell a public function from an internal one, so the check
is the app's.

`send` opens a new thread when `threadId` is left out, or when it is a UUID or
ULID no thread has yet: the page may choose its thread's id, as a TanStack AI
chat does. The id must be in the form Hercules keeps it in: a UUID in
lowercase, as `crypto.randomUUID()` makes, or a ULID in uppercase. Any other
`threadId` that names no thread is refused with `invalid_request` before
anything is written. A deleted thread's id is retired: `send` under it throws
`thread_deleted`, so the page starts the next chat under a new id.

The caller is the signed-in user, from `ctx.auth`. Without a signed-in user
`send` throws `sign_in_required`, and the other methods answer `null` or
`false`. A thread answers only to the user who opened it: anyone else reads
`null`.
Failures throw a `ConvexError` whose `data` is `{ code, message,
retryAfterSeconds? }`, with `code` one of `sign_in_required`, `not_found`,
`thread_deleted`, `thread_busy`, `end_user_rate_limited`, `message_too_long`
and `invalid_request`.

### When a run finishes

```ts
// convex/orders.ts
import { runFinishedValidator } from "@usehercules/agents/convex";

export const onAgentRunFinished = internalMutation({
  args: runFinishedValidator.fields,
  handler: async (ctx, run) => {
    // run.status is completed, failed, cancelled or capped; run.output is the reply.
  },
});
```

### What the page sees of tools

A thread goes to the user's browser, so by default it leaves out what the
agent's tools did in detail:

- A Hercules tool call (a built-in or a connector) is named `tool`, with the
  summary `Used a tool`, or `Couldn't use a tool` when it failed.
- No tool call carries its result. The app's own tools and page actions keep
  their names and summaries: they are the app's.

Hercules does the same to the run's live stream, so what streams and what is
stored read alike. Set `exposeToolDetails: true` to show the page the tool
calls as they are: Hercules's tool names and summaries in the thread, and
those plus the results of the app's tools in the live stream.

The component stores everything as delivered either way. The app's backend
reads it with `readThreadDetails`, which returns the thread unhidden with
`toolCalls`, each with its `resultJson`:

```ts
// convex/audit.ts
export const toolCallsOf = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) =>
    (await support.readThreadDetails(ctx, { threadId }))?.toolCalls ?? [],
});
```

`readThreadDetails` does not read `ctx.auth` and answers for any user's
thread of this agent. Call it from an internal function, or check who is
asking first, and do not return it to a page.

### When a page action runs

A page action is the agent's command to the page, such as opening a record.
List its name in `pageActions`, and give the page a handler for it (below).
One open tab claims each call with `claimPageAction` and runs it. A page
action can be claimed once Hercules has delivered it to the app, and only
until it expires, a set time after the agent called it. The claim decides
that on the server's clock, so a browser's clock plays no part.

A run sends the page only the page actions it was started with. One under any
other name is dropped when Hercules delivers it, with a warning in the Convex
logs that names it, so no page lists or claims it. In the page, a handler runs
only when the page set a function under that exact name.

One that came too late is not run, and the page is told: `thread.pageActions`
lists the page actions no tab has run (up to a set number: those that have
waited longest), each with `status: "pending"` or `"expired"`, for a set time
from when it arrived. The status is as of the thread's last update: a Convex query is not
run again as time passes, so a page sees `expired` with the next update of
the thread. A claim that is refused as too late is such an update. Show the expired ones, so
the user is not left waiting for something that will not happen:

```tsx
const late = thread?.pageActions.filter((action) => action.status === "expired") ?? [];
// "The assistant tried to open something for you, but it arrived too late."
```

### Deleting a thread

`deleteThread` removes the thread from the app at once. Its other rows are
purged in batches, and Hercules is asked to delete its copy until it confirms:
it answers `thread_busy` while the thread's run is still stopping, and the
component asks again as told, for a set time. A 404 counts as "gone" only
once it has been the answer for a while, since Hercules also answers 404
while the agents API is off for the app. Both are driven by a mutation
that reschedules itself, so neither stops halfway.

Hercules is asked to delete only a thread it took a run on. It takes a run
only for the user the run was sent for, so a run it took is what tells the
component that the thread under that id at Hercules is the caller's. A thread
whose runs Hercules all refused, or never got, is deleted in the app alone.
One deleted while its first run is still being started is deleted at Hercules
once Hercules says it has that run.

Deleting a thread does not give its runs back: they count toward
`limits.runsPerUserPerHour` for as long as any run does.

### Several agents

An app can have several `HerculesAgents`, each with its own functions. A
thread belongs to the agent it was started with: the other agents' `thread`,
`cancel`, `claimPageAction` and `deleteThread` answer as if it did not exist,
so one agent's `exposeToolDetails` never shows another agent's tool calls.

### The events route

`support.registerRoutes(http)` routes `POST /hercules/agents/events`. Hercules
signs each delivery for `https://<deployment>.convex.site/hercules/agents/events`,
so the route takes a token for that path on `CONVEX_SITE_URL`, and on the
`.convex.site` origin that goes with `CONVEX_CLOUD_URL`. A deployment that
points `CONVEX_SITE_URL` at a custom domain keeps working. A deployment that
overrides both variables with custom domains cannot be delivered to: the
route would answer 401 to every delivery, which Hercules reads as the whole
deployment refusing it. It then stops delivering to the deployment and comes
back to try after 30 seconds, 2 minutes, 10 minutes, then every hour. Leave
`CONVEX_CLOUD_URL` as Convex sets it.

Hercules acts on the status the route answers, so the route is careful with
them: 401 and 403 only for a token that was checked and is not Hercules's for
this route; 503 with `Retry-After` while the issuer's keys cannot be fetched;
500 while the app's environment is not set, or when one event cannot be
applied (tried again for a day); 413 when a batch of several events cannot be
applied (Hercules sends half). Event types and fields the package does not
know are accepted and skipped: see "Versioning".

### Configuration

`HerculesAgents` takes the agent's id, and these options:

| Option                      | What it sets                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `onRunFinished`             | The app's function to call when a run ends                                    |
| `limits.runsPerUserPerHour` | How many runs one signed-in user may start in an hour                         |
| `pageActions`               | The page actions every run may call, by name                                  |
| `exposeToolDetails`         | Whether a page sees tool calls as they are: see "What the page sees of tools" |
| `apiKey`                    | The app's Hercules key. Never send it to a browser                            |
| `apiUrl`                    | The Hercules API's URL                                                        |
| `issuer`                    | The app's Hercules Auth URL, which signs the deliveries Hercules sends        |

What each is when left out is under "Defaults and limits".

A component cannot read the app's environment, so the app key travels to the
component's scheduled functions as an argument. It never reaches a browser,
and is sent only to an `https` API URL (or `http://localhost`). A run's
stuck-run check keeps the key it was scheduled with, so a run that is going
while the key is rotated is settled by delivery, not by the check.

## In the page, with TanStack AI

The chat is TanStack AI's: `useChat` from `@tanstack/ai-react` keeps its
state, and the headless kit in `@tanstack/ai-react/ui` renders it with the
app's own components. `herculesConnection` is the TanStack connection that
talks to the agent through the app's Convex functions, the ones
`support.api()` builds.

```sh
npm install @tanstack/ai @tanstack/ai-client @tanstack/ai-react
```

The package is tested with `@tanstack/ai` 1.2.0, `@tanstack/ai-client` 1.1.0
and `@tanstack/ai-react` 1.0.2. Its own peers are `@tanstack/ai` and
`@tanstack/ai-client`, whose connection contract it implements. It never
imports `@tanstack/ai-react`: that one is the app's, for `useChat`.

```tsx
// src/components/agent-chat.tsx
import { useState, type ComponentType, type FormEvent } from "react";
import { useChat, type UIMessage, type UseChatReturn } from "@tanstack/ai-react";
import { createChatUI, TextPart } from "@tanstack/ai-react/ui";
import { agentErrorCode, herculesConnection, useThreadSync } from "@usehercules/agents/tanstack";
import { useConvex, useConvexAuth } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const chatOptions = { persistence: true } as const;

// The chat's components, once at module scope. The connection is not made
// here: it needs the app's signed-in Convex client, which `SignedInChat` reads.
const { Chat, useChatContext } = createChatUI(chatOptions, {
  components: { layout: ChatLayout, message: ChatMessage },
  partsComponents: {},
});

// The chat is for signed-in users. Render it once Convex knows who is asking:
// the chat reads its thread when it mounts, and before that the thread reads
// as empty and a message is refused with `sign_in_required`.
export function AgentChat({ threadId }: { threadId: string }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <p>Sign in to chat.</p>;
  return <SignedInChat threadId={threadId} />;
}

function SignedInChat({ threadId }: { threadId: string }) {
  // The client the app's ConvexProvider holds, signed in as the user.
  const convex = useConvex();
  // Once per chat: `useChat` keeps the first connection it gets.
  const [connection] = useState(() => herculesConnection(convex, api.agent));
  const chat = useChat({ ...chatOptions, connection, threadId });
  // Replies another tab or device got show here too.
  useThreadSync(chat, api.agent.thread, { threadId });
  return (
    <div className="flex flex-col gap-2">
      <Chat chat={chat} />
      <ChatInput chat={chat} />
    </div>
  );
}

function ChatLayout({ Messages }: { Messages: ComponentType }) {
  const chat = useChatContext();
  return (
    <div aria-live="polite">
      <Messages />
      {chat.isLoading && <p>Thinking...</p>}
    </div>
  );
}

// Renders every part itself, so a tool call the page has no component for still shows.
function ChatMessage({ message }: { message: UIMessage }) {
  return (
    <div data-role={message.role}>
      {message.parts.map((part, index) => {
        if (part.type === "text") return <TextPart key={index} content={part.content} />;
        // `part.output` is `{ kind, status, summary }` once the call ends,
        // or "sent to the page" for a page action. A Hercules tool is named
        // "tool" here unless the app set `exposeToolDetails`.
        if (part.type === "tool-call" && part.output === undefined) {
          return <p key={index}>Working on it...</p>;
        }
        return null;
      })}
    </div>
  );
}

function ChatInput({ chat }: { chat: UseChatReturn }) {
  const [text, setText] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || chat.isLoading) return;
    void chat.sendMessage(text);
    setText("");
  }
  return (
    <form onSubmit={submit}>
      {chat.error && <p role="alert">{errorText(chat.error)}</p>}
      <Textarea value={text} onChange={(event) => setText(event.target.value)} />
      {chat.isLoading ? (
        <Button type="button" variant="outline" onClick={() => chat.stop()}>
          Stop
        </Button>
      ) : (
        <Button type="submit">Send</Button>
      )}
    </form>
  );
}

function errorText(error: unknown): string {
  const code = agentErrorCode(error);
  if (code === "sign_in_required") return "Sign in to chat.";
  // The app's setup: sending again will not help.
  if (
    code === "hercules_auth_required" ||
    code === "agent_not_found" ||
    code === "client_upgrade_required"
  ) {
    return "The assistant is not available right now.";
  }
  // The agent is turned off, or not open to this app.
  if (code === "agent_unavailable") return "The assistant is not available right now.";
  return "Not sent. Try again.";
}
```

- **The app's own Convex client.** `useConvex()` returns the client the
  app's `ConvexProvider` holds, which is signed in as the user. A
  `ConvexReactClient` made at module scope for the chat is a second client
  that is not signed in, so every message fails with `sign_in_required`. In a
  TanStack Start app the client is made in `getRouter()`, so there is no
  module-scoped one to import either.
- **One connection per chat.** `useChat` builds its chat from the first
  connection it gets, so make it once with `useState`, not on every render.
- **Tool calls render in `message`.** The kit's `toolsComponents` shows only
  the tools it names and drops the rest, and an agent also calls tools the
  app does not know, such as Hercules' own.
- **Hooks in named components.** Call `useChatContext()` in a component such
  as `ChatLayout`, not in an arrow function written inside the `components`
  object, which breaks `react-hooks/rules-of-hooks`.

The thread's id is the page's to choose: a UUID for a new chat
(`crypto.randomUUID()`), kept in the URL so a reload opens the same thread.
The first message opens the thread under it. With `persistence: true` the
chat reads the thread from Convex when it mounts, and joins a reply still
being written.

```tsx
// src/routes/chat.$threadId.tsx
export const Route = createFileRoute("/chat/$threadId")({
  component: function ChatPage() {
    const { threadId } = Route.useParams();
    return <AgentChat threadId={threadId} />;
  },
});
// A new chat: navigate({ to: "/chat/$threadId", params: { threadId: crypto.randomUUID() } })
```

### Page actions

A page action is an agent's command to the page, such as opening a record.
List its name in `pageActions` in `convex/agent.ts`, and register its handler
on the connection in `SignedInChat`. One open tab claims each call through the
app's `claimPageAction` mutation, from `support.api()`, and runs it. It runs
when Hercules has delivered the call to the app, a moment after it shows in
the chat, and not at all once it has expired by the server's clock.

```tsx
// What an order's id looks like in this app. At module scope.
const ORDER_ID = /^[\w-]{1,64}$/;

// In SignedInChat, after useChat. useNavigate is TanStack Router's.
const navigate = useNavigate();
useEffect(() => {
  connection.setPageActions({
    // Untrusted input: check the id, then go to a fixed route with it.
    open_order: ({ orderId }) => {
      if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) return;
      // The router encodes the id into the path.
      void navigate({ to: "/orders/$orderId", params: { orderId } });
    },
  });
  return () => connection.setPageActions(undefined);
}, [connection, navigate]);
```

A model writes the arguments, and it may have been steered by text it read,
so treat them as untrusted input. A handler navigates within the app or
adjusts what the page shows: it never submits, purchases, deletes or changes a
setting. Validate an id and build the URL from a fixed route plus the encoded
id, never navigate to a URL taken from an argument, and never render an
argument as HTML.

Handlers that need nothing from React can go in `herculesConnection`'s
`pageActions` option instead, when the connection is made. A page action is
one-way: it shows in the chat as a tool call with the result "sent to the
page", which the package exports as `PAGE_ACTION_OUTPUT`, and nothing goes
back to the run.
Do not register it as a TanStack client tool: the adapter answers every tool
call itself, so TanStack never runs one or starts a second run.

### The connection's options

`herculesConnection(convex, api.agent, options)` takes the app's Convex
client, the functions `support.api()` built, and these options, each of which
can be left out:

| Option            | What it sets                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pageActions`     | The page's handlers, by name: see "Page actions"                                                                                                                                    |
| `fetch`           | The `fetch` that reads a run's live stream                                                                                                                                          |
| `retry`           | How the live stream is connected to again: the first wait and the longest, in milliseconds, and how many tries in a row                                                             |
| `settleTimeoutMs` | How long the connection waits for Convex to have a run's end: after the live stream ends, and before a message sent while a stopped run is still ending is refused as `thread_busy` |

### Context, errors and progress

- Send named JSON values about the page with a message:
  `chat.sendMessage(text, { body: { context: { page: "/orders/123" } } })`.
- `chat.error` is set when a message was not sent or a run failed. Read why
  with `agentErrorCode(chat.error)`: `sign_in_required`, `thread_busy`,
  `thread_deleted`, `end_user_rate_limited`, `message_too_long`,
  `invalid_request` and `not_found` from `send`, or the run's own code, such
  as `out_of_credits`, `end_user_rate_limited` or
  `agent_daily_limit_reached`. For a run that failed over a limit,
  `thread.latestRun.error.retryAfterSeconds` says how long it lasts, counted
  from `thread.latestRun.finished_at`.
- Some codes are not the user's to fix by starting over. `agent_not_found`
  is the app's setup: Hercules has no agent with the id in `convex/agent.ts`
  for this app, or the agents API is not turned on for it.
  `hercules_auth_required` is the app's setup too: it has to be upgraded to
  Hercules Auth 2.0 before any run can start. So is
  `client_upgrade_required`: the app runs a version of this package that
  Hercules no longer takes, and the package has to be upgraded. For both, the
  message on `chat.error` is for the user, "The assistant is not available
  right now."; the Convex logs
  say what to do. `not_found` from `send` is a thread that is not this
  user's or not this agent's.
- `agent_unavailable` is the app's setup as well: Hercules will not run the
  agent for the app, because the agent is turned off, is not open to apps,
  has no owner, or its organization is suspended. Its message on
  `chat.error` is "The assistant is not available right now."
- A run's ending is found by the run, not only by the thread's latest run.
  When the thread already has a newer run (the app's `onRunFinished` started
  a follow-up, or another tab sent a message) and this run's reply is stored,
  the chat ends the run as finished.
- A live view that fails is not an error here. If Hercules refuses the run's
  stream, or keeps answering 429 because more than ten tabs stream the same
  run, the connection reads the reply from Convex instead: it arrives whole,
  without the typing effect, and `chat.error` stays unset. The connection
  also stops waiting on the stream as soon as Convex has the run's end.
- A page action that reached the app too late is not run. `useThreadSync`
  returns the thread, and `thread.pageActions` lists it with
  `status: "expired"` for a while, for the page to tell the user.
- `useThreadSync` returns the thread: `thread.activeRun?.progress` is the
  run's latest progress label. Each also comes to `useChat`'s
  `onCustomEvent` as `hercules.progress` with `{ label }`.
- `chat.stop()` stops the run with the app's `cancel` mutation. The chat is
  free at once, and the run takes a moment longer to end. A message sent in
  that moment waits for the run to end (for `settleTimeoutMs` at most) and is
  then sent, or is refused as `thread_busy` when the run has not ended by
  then. `thread.activeRun?.stopping` says a stop is on its way, for a page
  that would rather hold its Send button.
- A reply that was stopped while it was written is kept as far as it was
  written. When the run ends, Hercules delivers that text as the run's reply
  and the thread holds it as a `completed` message, so the chat shows the
  same text here, in another tab and after a reload. `thread.latestRun.status`
  is then `"cancelled"`, for the page to say the reply was stopped. A run
  stopped before it wrote any text leaves no reply.
- When a run ends and the thread holds less of its reply than this page
  streamed (a run that failed while it was writing, say), the page's text
  stays in the chat, with `metadata.hercules.status` set to `"incomplete"`. A
  reload, or another tab, shows what the thread holds.
- `chat.error` is not kept across a reload. To say why the last message got
  no reply after one, read the thread: when `thread.latestRun.status` is
  `"failed"`, `thread.latestRun.error.code` is the run's code.
- `chat.isLoading` is about this page's stream. A run Convex still has going
  when it is false (`thread.activeRun` is not null) is one this page is not
  streaming: it was started in another tab, or its ending has not been
  delivered to the app yet. A message sent then fails with `thread_busy`, so
  hold Send, or say that the reply is still finishing.
- A run another tab started shows here through `useThreadSync` as Convex
  gets it: the message that started it, then the reply as far as Hercules
  has delivered it to the app (in steps, while it is written), then the reply
  whole. It is not streamed live in this tab.
- The chat is for signed-in users: gate it with `useConvexAuth()`, as
  `AgentChat` does above. Without a signed-in user every message fails with
  `sign_in_required`.

### How it maps

- `connect` calls `send`, then reads the run's live events from Hercules,
  resuming with `Last-Event-ID`, and turns them into AG-UI chunks:
  `RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*` with a result for every
  call, then one `RUN_FINISHED` or `RUN_ERROR`. It ends once Convex has the
  run's end, so the next message never finds the thread busy.
- `hydrate` reads the thread once as TanStack `UIMessage`s. A message's
  `metadata.hercules` is a `HerculesMessageMetadata`: its `runId`, and a
  `status` once the thread or the run's ending has said one. Page action
  arguments are not kept with the messages, so a reloaded page action has
  none.
- `joinRun` replays a run that is still going from its start.
- If Hercules refuses the live stream, the reply is read from Convex.
- A completed message is the truth. When Hercules retries a step, the step's
  text streams a second time, and a stream can only add to a message. So when
  a message completes as something other than what streamed plus more, the
  adapter replaces the chat's messages with the thread as Convex has it and
  the message as it completed (a `MESSAGES_SNAPSHOT`). It does not do this
  for a thread longer than the read holds (`hasMore`), where a snapshot would
  drop the older messages the chat shows: `useThreadSync` corrects that one
  when the run is over.

AG-UI and TanStack's shapes exist only in the browser. Hercules sends, and
Convex keeps, the agents API's own events and messages.

## In React, without TanStack

`useAgentThread` is a lighter hook for a page that renders the chat itself.

```tsx
import { useAgentThread } from "@usehercules/agents/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// The chat is for signed-in users. Render it once Convex knows who is asking:
// before that the thread reads as null, and a message is refused with
// `sign_in_required`.
function ChatGate() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <p>Sign in to chat.</p>;
  return <Chat />;
}

function Chat() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const chat = useAgentThread({
    threadId,
    thread: useQuery(api.agent.thread, threadId === null ? "skip" : { threadId }),
    send: useMutation(api.agent.send),
    cancel: useMutation(api.agent.cancel),
    claimPageAction: useMutation(api.agent.claimPageAction),
    pageActions: {
      // Untrusted input: check the id, then build the URL from it.
      open_order: ({ orderId }) => {
        if (typeof orderId !== "string" || !/^[\w-]{1,64}$/.test(orderId)) return;
        navigate(`/orders/${encodeURIComponent(orderId)}`);
      },
    },
  });

  async function submit(text: string) {
    const started = await chat.send(text);
    if (started !== null) setThreadId(started.threadId);
  }
  // chat.messages, chat.status ("loading" | "ready" | "submitted" | "streaming"),
  // chat.cancel(), chat.error
}
```

The reply streams from the run's live URL, resuming with `Last-Event-ID`
after a dropped connection, until Convex has the completed message. Page
actions are one-way: one open tab claims each and runs it, and nothing goes
back to the run. The hook takes them from `thread.pageActions`, so one runs
when Hercules has delivered it. A handler's arguments are untrusted input:
the rules under "Page actions" above hold here too.

`thread` returns the thread's newest messages: as many as `limit` says, when
it is a whole number of at least one, up to the most one read returns.
`thread.hasMore` says there are older ones.

`chat.error` is one of three things, or null:

- An `AgentError` with a `code`. The message was not sent (one of `send`'s
  codes), or the latest run failed (the run's code, such as `out_of_credits`
  or `agent_daily_limit_reached`). For a limit it also has
  `retryAfterSeconds`. `agent_not_found`, `agent_unavailable`,
  `hercules_auth_required` and `client_upgrade_required` are the app's setup,
  not the chat. For the last three the message is "The assistant is not
  available right now.": the agent's setup has to be checked in Hercules, the
  app upgraded to Hercules Auth 2.0, or this package to a version Hercules
  still takes.
- A `RunStreamError`, only while a run is going. The live view of the reply
  could not be read: Hercules refused the stream, or kept answering 429
  because too many streams of the run are open. The run is not affected. The reply still arrives through `thread`, without the
  typing effect, and the error clears when the run is over. Do not show it as
  a failed message.
- Any other `Error` a mutation threw, such as a lost connection.

```tsx
import { AgentError, RunStreamError } from "@usehercules/agents/react";

if (chat.error instanceof RunStreamError) {
  // Nothing to tell the user: the reply is on its way through Convex.
} else if (
  chat.error instanceof AgentError &&
  [
    "agent_not_found",
    "agent_unavailable",
    "hercules_auth_required",
    "client_upgrade_required",
  ].includes(chat.error.code)
) {
  // The app is set up wrong. Starting a new chat will not help.
}
```

## App tools

Declare tools next to your backend functions, serve them to Hercules agents
as an MCP server, and let Hercules Auth decide who is calling them.

```ts
// convex/tools.ts
import { defineTools, tool } from "@usehercules/agents/convex";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const tools = defineTools({
  tools: {
    create_task: tool({
      description: "Creates a task for the signed-in user.",
      args: { title: v.string(), dueAt: v.optional(v.number()) },
      returns: v.object({ id: v.string(), title: v.string() }),
      annotations: { readOnlyHint: false },
      handler: (ctx, args, caller) =>
        ctx.runMutation(internal.tasks.createFor, {
          tokenIdentifier: caller.tokenIdentifier,
          ...args,
        }),
    }),
  },
});
```

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { support } from "./agent";
import { tools } from "./tools";

const http = httpRouter();
support.registerRoutes(http); // If the app also talks to an agent: its events.
tools.registerRoutes(http); // The app's tools, at /mcp.
export default http;
```

The tools are served at `https://<deployment>.convex.site/mcp`.

### Who is calling

A tool handler has no `ctx.auth`. The package checks the bearer token itself,
so the token is worth nothing on the app's other functions. The verified
caller is the handler's third argument:

| `caller.principal` | Who                               | Fields                                                                                                                                                           |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"user"`           | A signed-in end user of the app   | `tokenIdentifier` (the same `<issuer>\|<subject>` the app stores for their web session), `issuer`, `subject`, and `agentId` when a Hercules agent calls for them |
| `"agent"`          | A Hercules agent with no end user | `agentId`, and `origin`: where the agent's run was started                                                                                                       |

Pass the caller to an internal function explicitly. Never take a user id from
the tool's arguments: the model writes those.

```ts
// convex/tasks.ts
export const createFor = internalMutation({
  args: { tokenIdentifier: v.string(), title: v.string(), dueAt: v.optional(v.number()) },
  handler: async (ctx, { tokenIdentifier, ...task }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    if (user === null) throw new ConvexError("No account found for this user.");
    const id = await ctx.db.insert("tasks", { ...task, ownerId: user._id });
    return { id, title: task.title };
  },
});
```

Tools accept signed-in users only, unless `principals` says otherwise. A
tool an agent may run with no end user says so with `"agent"`, and its
handler then has to handle both:

```ts
list_open_hours: tool({
  description: "Lists the shop's opening hours.",
  args: {},
  principals: ["user", "agent"],
  handler: (ctx) => ctx.runQuery(internal.shop.openHours, {}),
}),
```

#### Where a run with no end user was started

A run has no end user when nobody signed in to the app asked for it. Hercules
signs where such a run was started into the token of every call it makes, and
the handler reads it as `caller.origin`:

| `caller.origin`  | The run was started                                                 |
| ---------------- | ------------------------------------------------------------------- |
| `"app"`          | By this app's own backend, with its app key and no end user (`run`) |
| `"organization"` | With an Organization API key                                        |
| `"console"`      | From the Hercules console                                           |
| `"trigger"`      | By one of the agent's triggers                                      |
| `"channel"`      | From one of the agent's channels                                    |
| `"schedule"`     | By one of the agent's schedules                                     |
| `"test"`         | As a test, while the agent is being built                           |
| `null`           | The token does not say                                              |

Hercules may add origins. One this version of the package does not know
reaches the handler as the string Hercules signed.

**A tool that lists `"agent"` takes the app's own job, and nothing else,
unless it says so.** That is the origin `"app"`. To take a call from other
origins, name them in `agentOrigins`, beside `principals`:

```ts
send_daily_digest: tool({
  description: "Sends the daily digest to every subscriber.",
  args: {},
  principals: ["agent"],
  // The app's own job, and a run one of the agent's schedules started.
  agentOrigins: ["app", "schedule"],
  handler: (ctx, _args, caller) =>
    ctx.runMutation(internal.digest.send, { startedBy: caller.origin }),
}),
```

- Left out, `agentOrigins` is that one origin.
- A call whose token names an origin the tool does not list is refused. So is
  one whose token names no origin, or one the package does not know: neither
  is taken for the app's own job.
- `agentOrigins: "any"` takes every call with no end user, wherever its run
  was started, one whose token does not say among them. The handler can
  still tell them apart by `caller.origin`.
- `agentOrigins` is only for a tool that lists `"agent"`. On any other tool
  it is a type error, and `defineTools` throws when the module loads. So does
  an empty list.
- Signed-in users are not affected: a `"user"` caller has no origin, and a
  tool that lists `"user"` takes them whatever `agentOrigins` says, with an
  agent acting for them or not.

A caller never sees, and cannot call, a tool that does not accept them:
`tools/list` and `tools/call` apply the same rule.

### Arguments and results

- `args` are checked before the handler runs. Unknown fields are refused, and
  the model is told which field was wrong.
- `returns` is enforced. Object fields it does not name are removed before the
  result leaves the app, so it is also the list of fields an assistant may
  see. Declare it on any tool that reads user data.
- A tool whose `returns` is a `v.object` or a `v.record` is listed with that
  shape as its MCP output schema, and its result is sent as structured
  content. MCP takes only an object there, so any other `returns` (an array,
  a string, a union) is enforced the same way and sent as text.
- `v.int64()` travels as a decimal string and `v.bytes()` as base64.

### Errors

Throw `ToolError` or a `ConvexError` with a string to tell the model what
went wrong in words it can act on. Any other error is logged and reaches the
model as a generic failure, so internal detail does not leak.

### Several servers

Name each set of tools when the app splits them by data or risk. Each is its
own MCP server with its own URL, and a token issued for one is refused by the
others.

```ts
export const supportTools = defineTools({ name: "support", tools: { ... } }); // /mcp/support
export const billingTools = defineTools({ name: "billing", tools: { ... } }); // /mcp/billing
```

### How tokens are checked

A request must carry an RS256 JWT signed by the app's Hercules Auth
(`HERCULES_OIDC_AUTHORITY`), issued for this server's own URL, and not
expired. It must say who is calling in its `hercules_principal` claim: a
token without one is refused. Keys come from the issuer's OpenID discovery
document and are cached for a few minutes. While they cannot be fetched, and
for a key the cached set lacks until the keys may be fetched again (a short
wait, as after a key rotation), the server answers 503 with
`Retry-After`, never 401: that says nothing about the token. It answers 401
for an unknown key only when the keys were fetched after the token came and
its key is still not among them.

Hercules calls a server at `/mcp`, or `/mcp/<name>` for a named one, on the
deployment's own `https://<name>.convex.site`, and signs its tokens for that
URL. So the server takes a token for its path on `CONVEX_SITE_URL`, and on
the `.convex.site` origin that goes with `CONVEX_CLOUD_URL`: a deployment that
points `CONVEX_SITE_URL` at a custom domain keeps working. A deployment that
overrides both variables must pass `audiences` to `defineTools` with its
`https://<name>.convex.site/mcp` URL, or every call is refused with 401.

Pass `issuer` or `audiences` to `defineTools` to override either.

### Other backends

`@usehercules/agents` exports the backend-neutral core (`createMcpHandler`,
`createTokenVerifier`): a function from a web `Request` to a `Response`. An
adapter supplies the tools and the context their handlers receive.

### Not supported yet

Server-sent events, resources, prompts, sampling and elicitation.

## Defaults and limits

Every default, limit and time the package keeps to is stated here, and only
here: the other sections name them without their values. An app may rely on
them. They are part of what "Versioning" promises.

### Options left out

| Option                      | Of                                                                         | When it is left out                                                    |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apiKey`                    | `HerculesAgents`                                                           | The `HERCULES_API_KEY` environment variable                            |
| `apiUrl`                    | `HerculesAgents`                                                           | `HERCULES_API_URL`, then `https://api.hercules.app`                    |
| `issuer`                    | `HerculesAgents`, `defineTools`                                            | `HERCULES_OIDC_AUTHORITY`                                              |
| `onRunFinished`             | `HerculesAgents`                                                           | Nothing is called when a run ends                                      |
| `pageActions`               | `HerculesAgents`                                                           | None: a run may call no page action                                    |
| `exposeToolDetails`         | `HerculesAgents`                                                           | `false`                                                                |
| `limits.runsPerUserPerHour` | `HerculesAgents`                                                           | No limit                                                               |
| `limit`                     | `thread`, `readThread`, `readThreadDetails`, `useThreadSync`               | 100 messages                                                           |
| `name`                      | `defineTools`                                                              | One server, routed at `/mcp`. A named one is at `/mcp/<name>`          |
| `audiences`                 | `defineTools`                                                              | The deployment's own URLs for the server: see "How tokens are checked" |
| `principals`                | `tool`                                                                     | `["user"]`                                                             |
| `agentOrigins`              | `tool`, when it lists `"agent"`                                            | `["app"]`                                                              |
| `pageActions`               | `herculesConnection`, `useAgentThread`                                     | None: the page runs no page action                                     |
| `settleTimeoutMs`           | `herculesConnection`                                                       | 10,000: ten seconds                                                    |
| `retry`                     | `herculesConnection`, `followRun`                                          | `{ initialMs: 1000, maxMs: 30000, maxAttempts: 10 }`                   |
| `after`                     | `followRun`                                                                | 0: the run is read from its start                                      |
| `fetch`                     | `herculesConnection`, `useAgentThread`, `followRun`, `createTokenVerifier` | The global `fetch`                                                     |

### Limits

| Limit                                                           | Value                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| A message: its `text`, plus its `context` as the agent reads it | 262,144 characters. A longer one is refused with `message_too_long` |
| The messages one read of a thread returns                       | 200 at most, and fewer once they come to more than about 4 MiB      |
| How long a run counts toward `limits.runsPerUserPerHour`        | One hour from when it was sent                                      |
| The page-action expiry: how long a page action can be claimed   | Two minutes (120 seconds) from when the agent called it             |
| How long a page action no tab ran stays listed on its thread    | Ten minutes from when it reached the app                            |
| The page actions a thread lists                                 | 20 at most                                                          |

### Times

| What                                                                                                                                                                                          | When                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A run with nothing delivered is asked about at Hercules                                                                                                                                       | After 3 minutes                                                                |
| A run Hercules says is still going is asked about again                                                                                                                                       | After twice the wait before: at 3, 6, 12 and 24 minutes, then every 30 minutes |
| The give-up time: how long a run is kept with nothing heard of it, how long a start Hercules cannot answer is sent again, and how long after it was sent a run that was asked to stop is kept | One day                                                                        |
| The busy wait: a start refused as `thread_busy` is sent again                                                                                                                                 | For one minute                                                                 |
| The rate-limit tries: how often a start answered 429, with a code that is not a quota, is sent                                                                                                | 8 times in all                                                                 |
| Hercules is asked to delete a deleted thread's copy                                                                                                                                           | For one day                                                                    |
| A 404 from Hercules for a run, or for a deleted thread, is taken as final                                                                                                                     | Once it has been the answer for one hour                                       |
| The issuer's signing keys are kept                                                                                                                                                            | 5 minutes                                                                      |
| The keys are fetched again for a key the kept ones lack                                                                                                                                       | 30 seconds after the last fetch, at the soonest                                |

## Versioning

`@usehercules/agents` follows [semantic versioning](https://semver.org) from
1.0.0. Within a major version, an upgrade does not break an app that uses the
public API as this README describes it: what is listed below keeps its name,
its arguments, what it returns and what it does. A change to any of it is a
new major version.

An app Hercules builds pins an exact version of the package, and keeps
running that version until someone upgrades it. Pin it in your own app too:

```sh
npm install --save-exact @usehercules/agents
```

### What the public API is

- The exports of these entry points that this README documents, with their
  options, their return values and the error codes they name:

  | Entry point                         | Exports                                                                               |
  | ----------------------------------- | ------------------------------------------------------------------------------------- |
  | `@usehercules/agents/convex.config` | The `herculesAgents` component, as the default export                                 |
  | `@usehercules/agents/convex`        | `HerculesAgents`, `runFinishedValidator`, `defineTools`, `tool`, `ToolError`          |
  | `@usehercules/agents/tanstack`      | `herculesConnection`, `useThreadSync`, `agentErrorCode`, `PAGE_ACTION_OUTPUT`         |
  | `@usehercules/agents/react`         | `useAgentThread`, `AgentError`, `RunStreamError`                                      |
  | `@usehercules/agents`               | `followRun`, `RunStreamError`, `createMcpHandler`, `createTokenVerifier`, `ToolError` |

  Each entry point also exports the types of what it takes and returns.

- The functions `support.api()` builds: their names, their arguments and what
  they return, the thread among them.
- What `onRunFinished` is called with, and what a tool's handler is called
  with.
- The routes the package serves in the app: `POST /hercules/agents/events`,
  and `/mcp` or `/mcp/<name>`.
- Every value under "Defaults and limits".

A minor version may add to these: an export, an option, a field on something
the package returns or passes to the app's functions, or a member of a union
that mirrors the Hercules API (event types, run statuses, tool kinds,
origins, error codes). So:

- Match on the codes and statuses you handle, and keep a default for the
  rest.
- Take `onRunFinished`'s arguments as `runFinishedValidator.fields`, which
  holds whatever fields the installed version sends.
- When you wrap a method in a function of your own, do not copy the shape of
  what it returns into a `returns` validator.

### What it is not

- Anything these entry points do not export, such as a file imported by its
  path inside the package.
- `@usehercules/agents/_generated/component`. It is there for Convex's code
  generation, which reads the component's types from that path. An app does
  not import it.
- The component's own functions and tables. An app reaches them only through
  `HerculesAgents`: do not call `components.herculesAgents` functions or read
  its tables directly. A version reads what earlier versions of the same
  major stored, so an upgrade keeps an app's threads.
- What the package logs: the wording, the level, and when.
- The exact requests the package makes to Hercules: their paths, headers and
  bodies, and how many it makes.
- What Hercules itself does, where this README describes it for context: how
  it retries a delivery, how many streams of one run it allows, which codes
  it sends. That is the Hercules API's to define.

### Compatibility with the Hercules API

The Hercules API adds to a version without changing it: new event types,
fields, statuses, part types and error codes can arrive at any time. An app
keeps running the version of this package it was built with, so the package
is written to meet what it has never seen. Every version promises this, in
the app's backend and in the page alike:

- **Nothing new is refused, and nothing new throws.** A delivery that holds
  events the package does not know is applied and answered 2xx: the events
  it knows are applied, the others keep their place in the run's sequence
  and change nothing.
- **A field it does not know is not read.** On a run, an event, a message, an
  error or the answer to a start, the fields it knows are read as before.
- **A message part of a type it does not know is left out.** The parts beside
  it are kept, in order.
- **A run status it does not know is a run that is still going.** A run ends
  only as `completed`, `failed`, `cancelled` or `capped`. Until then the
  thread has its `activeRun`, the page shows the run as going and can stop
  it, `send` throws `thread_busy`, and `onRunFinished` is not called.
- **A run can stay unfinished for a long time.** A run that waits, for a
  person say, is kept open for as long as Hercules says it is going, and is
  asked about less and less often. It is failed only once nothing was heard
  of it for the give-up time. The live stream of a quiet run is followed for
  as long as it takes.
- **An ending it does not know still ends the run.** A run Hercules reports
  as finished, in a status or with a final event added later, is recorded as
  `failed` with the code `run_failed`, and keeps the reply it wrote.
- **A tool call of a kind it does not know is kept**, as a `hercules` tool
  call: the kind whose name and summary a page is not shown unless the app
  set `exposeToolDetails`. One that ended with a status it does not know is
  kept as `failed`: it is not known to have worked.
- **An error code is any string.** A run that fails with a code the package
  does not know, or that Hercules refuses with one, fails with that code and
  the message Hercules sent. A `capped` run whose reason the package does
  not know has `cappedReason: null`.

Every request the package makes to Hercules names the package and its
version in a `Hercules-Client` header: the app's backend's requests, and the
page's request for a run's live stream. Hercules can answer
`client_upgrade_required` to a version it no longer takes: see "How it
works" for what the package does then.
