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

If nothing has been delivered for a run in three minutes, the component asks
Hercules for the run and then its events itself, so a delivery that never
arrives only delays a reply. While Hercules says the run is still going it
asks less and less often (after 3, 6, 12 minutes, up to every 30), and any
delivered event starts that over. The same check sends a run again if the call
that starts it was lost, asks again for a cancel that did not get through,
and records a run's ending only once every event before it is applied. The
check is started by a mutation that reschedules itself, which Convex never
loses, so a run is not left open and its thread busy. A run that cannot be
settled within a day is failed, so its thread is free again.

A start Hercules cannot answer is not a refusal. On a 503, any other 5xx, a
timeout or a network error the run stays open and is sent again under the
same id, as told by `Retry-After` and then further apart, until Hercules
answers with the run or refuses it: Hercules may have the run already, and
says so in the 503 it answers while it cannot confirm the run started. A run
it never takes is failed after a day.

A run Hercules does not take fails with Hercules's own code. One of them is
the app's setup, not the conversation: `agent_not_found` means Hercules has
no agent with the id in `convex/agent.ts` for this app, or the agents API is
not turned on for it. A new chat will not help; fix the id.

A run Hercules refuses over a limit (`end_user_rate_limited`,
`agent_daily_limit_reached`) fails at once with that code. The thread's
`latestRun.error` then carries `retryAfterSeconds`, counted from
`latestRun.finished_at`.

### Methods

| Method                                                  | Where              | Does                                                                     |
| ------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `send(ctx, { threadId?, text, context? })`              | mutation           | Sends the caller's message and starts a run                              |
| `run(ctx, { threadId?, text, context? })`               | mutation or action | Starts a run as the app's own job, for no end user                       |
| `readThread(ctx, { threadId, limit? })`                 | query              | The caller's thread: its newest messages, the run going, its live stream |
| `readThreadDetails(ctx, { threadId, limit? })`          | query, internal    | A thread as stored, with tool results. For the app's backend             |
| `cancel(ctx, { threadId })`                             | mutation           | Stops the run going on the caller's thread                               |
| `deleteThread(ctx, { threadId })`                       | mutation           | Deletes the thread here and at Hercules. Irreversible                    |
| `claimPageAction(ctx, { threadId, runId, toolCallId })` | mutation           | Takes a page action for one tab to run                                   |
| `registerRoutes(http)`                                  | `convex/http.ts`   | Routes the events Hercules delivers. One route serves all agents         |

`send` opens a new thread when `threadId` is left out, or when it is a UUID or
ULID no thread has yet: the page may choose its thread's id, as a TanStack AI
chat does. The id must be in the form Hercules keeps it in: a UUID in
lowercase, as `crypto.randomUUID()` makes, or a ULID in uppercase. Any other
`threadId` that names no thread is refused with `invalid_request` before
anything is written. A deleted thread's id is retired: `send` under it throws
`thread_deleted`, so the page starts the next chat under a new id.

The caller is the signed-in user, from `ctx.auth`. There are no anonymous
visitors: without a signed-in user `send` throws `sign_in_required`, and the
other methods answer `null` or `false`. A thread answers only to the user who
opened it: anyone else reads `null`.
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
while it is less than two minutes old by the time the agent called it. The
claim decides that on the server's clock, so a browser's clock plays no part.

One that came too late is not run, and the page is told: `thread.pageActions`
lists the page actions no tab has run (the twenty that have waited longest),
each with `status: "pending"` or `"expired"`, for ten minutes from when it
arrived. The status is as of the thread's last update: a Convex query is not
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
component asks again as told, for up to a day. A 404 counts as "gone" only
once it has been the answer for an hour, since Hercules also answers 404
while the agents API is off for the app. Both are driven by a mutation
that reschedules itself, so neither stops halfway.

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
know are accepted and skipped.

### Configuration

| Option                      | Default                                             |
| --------------------------- | --------------------------------------------------- |
| `apiKey`                    | `HERCULES_API_KEY`                                  |
| `apiUrl`                    | `HERCULES_API_URL`, then `https://api.hercules.app` |
| `issuer`                    | `HERCULES_OIDC_AUTHORITY`                           |
| `pageActions`               | none: the page actions every run may call           |
| `exposeToolDetails`         | `false`: see "What the page sees of tools"          |
| `limits.runsPerUserPerHour` | no limit                                            |

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

TanStack AI 1.x, from `@tanstack/ai` 1.2, `@tanstack/ai-client` 1.1 and
`@tanstack/ai-react` 1.0.2. The package's own peers are `@tanstack/ai` and
`@tanstack/ai-client`, whose connection contract it implements. It never
imports `@tanstack/ai-react`: that one is the app's, for `useChat`.

```tsx
// src/components/agent-chat.tsx
import { useState, type ComponentType, type FormEvent } from "react";
import { useChat, type UIMessage, type UseChatReturn } from "@tanstack/ai-react";
import { createChatUI, TextPart } from "@tanstack/ai-react/ui";
import { agentErrorCode, herculesConnection, useThreadSync } from "@usehercules/agents/tanstack";
import { useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const chatOptions = { persistence: true } as const;

// The chat's components, once at module scope. The connection is not made
// here: it needs the app's signed-in Convex client, which `AgentChat` reads.
const { Chat, useChatContext } = createChatUI(chatOptions, {
  components: { layout: ChatLayout, message: ChatMessage },
  partsComponents: {},
});

export function AgentChat({ threadId }: { threadId: string }) {
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
      {chat.error && (
        <p role="alert">
          {agentErrorCode(chat.error) === "sign_in_required"
            ? "Sign in to chat."
            : "Not sent. Try again."}
        </p>
      )}
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
on the connection in `AgentChat`. One open tab claims each call through the
app's `claimPageAction` mutation, from `support.api()`, and runs it. It runs
when Hercules has delivered the call to the app, a moment after it shows in
the chat, and not at all once it is two minutes old.

```tsx
// In AgentChat, after useChat. useNavigate is TanStack Router's.
const navigate = useNavigate();
useEffect(() => {
  connection.setPageActions({
    // The agent writes the arguments: check them before acting on them.
    open_order: ({ orderId }) => {
      if (typeof orderId !== "string") return;
      void navigate({ to: "/orders/$orderId", params: { orderId } });
    },
  });
  return () => connection.setPageActions(undefined);
}, [connection, navigate]);
```

Handlers that need nothing from React can go in `herculesConnection`'s
`pageActions` option instead, when the connection is made. A page action is
one-way: it shows in the chat as a tool call with the result "sent to the
page", and nothing goes back to the run.
Do not register it as a TanStack client tool: the adapter answers every tool
call itself, so TanStack never runs one or starts a second run.

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
- `useThreadSync` returns the thread: `thread.activeRun?.progress` is the
  run's latest progress label. Each also comes to `useChat`'s
  `onCustomEvent` as `hercules.progress` with `{ label }`.
- `chat.stop()` stops the run with the app's `cancel` mutation.
- The chat is for signed-in users. Without one, every message fails with
  `sign_in_required`.

### How it maps

- `connect` calls `send`, then reads the run's live events from Hercules,
  resuming with `Last-Event-ID`, and turns them into AG-UI chunks:
  `RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*` with a result for every
  call, then one `RUN_FINISHED` or `RUN_ERROR`. It ends once Convex has the
  run's end, so the next message never finds the thread busy.
- `hydrate` reads the thread once as TanStack `UIMessage`s. A message's
  `metadata.hercules` holds its `runId`. Page action arguments are not kept
  with the messages, so a reloaded page action has none.
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
      open_order: ({ orderId }) => navigate(`/orders/${orderId}`),
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
when Hercules has delivered it.

`thread` returns the thread's newest messages: 100 unless `limit` is a whole
number of at least one, at most 200, and fewer when they come to more than about 4 MiB.
`thread.hasMore` says there are older ones.

`chat.error` is one of three things, or null:

- An `AgentError` with a `code`. The message was not sent (one of `send`'s
  codes), or the latest run failed (the run's code, such as `out_of_credits`
  or `agent_daily_limit_reached`). For a limit it also has
  `retryAfterSeconds`. `agent_not_found` is the app's setup, not the chat.
- A `RunStreamError`, only while a run is going. The live view of the reply
  could not be read: Hercules refused the stream, or kept answering 429
  because more than ten streams of the run are open (an eleventh tab). The
  run is not affected. The reply still arrives through `thread`, without the
  typing effect, and the error clears when the run is over. Do not show it as
  a failed message.
- Any other `Error` a mutation threw, such as a lost connection.

```tsx
import { AgentError, RunStreamError } from "@usehercules/agents/react";

if (chat.error instanceof RunStreamError) {
  // Nothing to tell the user: the reply is on its way through Convex.
} else if (chat.error instanceof AgentError && chat.error.code === "agent_not_found") {
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
import { tools } from "./tools";

const http = httpRouter();
tools.registerRoutes(http);
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
| `"agent"`          | A Hercules agent with no end user | `agentId`, and `visitorId` for a public agent's anonymous visitor                                                                                                |

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

Tools accept signed-in users only. A tool an agent may run with no end user
says so, and its handler then has to handle both:

```ts
list_open_hours: tool({
  description: "Lists the shop's opening hours.",
  args: {},
  principals: ["user", "agent"],
  handler: (ctx) => ctx.runQuery(internal.shop.openHours, {}),
}),
```

A caller never sees, and cannot call, a tool that does not accept them.

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
document and are cached for five minutes. While they cannot be fetched, and
for a key the cached set lacks until the keys may be fetched again (at most
30 seconds, as after a key rotation), the server answers 503 with
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
