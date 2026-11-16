# @usehercules/agents

Hercules agents in a Hercules app:

- **Talk to an agent** from a Convex app. The app's backend starts runs,
  Hercules delivers what they do into the app's own database, and the page
  streams the reply as it is written.
- **Serve the app's tools** to agents over MCP, with Hercules Auth deciding
  who is calling them.

The package has no runtime dependencies. It verifies tokens with Web Crypto,
so it fits in a Convex HTTP action.

| Entry point                         | What                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `@usehercules/agents/convex.config` | The `herculesAgents` Convex component                               |
| `@usehercules/agents/convex`        | `HerculesAgents`, and `defineTools`, `tool`, `ToolError`            |
| `@usehercules/agents/react`         | `useAgentThread`                                                    |
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

export const support = new HerculesAgents(components.herculesAgents, {
  agentId: "agt_01J...",
  onRunFinished: internal.orders.onAgentRunFinished,
  limits: { runsPerUserPerHour: 20 },
});

// send, thread, cancel, claimPageAction and deleteThread, for the page.
export const { send, thread, cancel, claimPageAction, deleteThread } = support.api();
```

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { support } from "./agent";

const http = httpRouter();
support.registerRoutes(http); // POST /hercules/agents/events
export default http;
```

To shape the functions yourself, call the methods from your own:

```ts
export const send = mutation({
  args: { threadId: v.optional(v.string()), text: v.string() },
  handler: (ctx, args) => support.send(ctx, args),
});
export const thread = query({
  args: { threadId: v.string() },
  handler: (ctx, { threadId }) => support.readThread(ctx, { threadId }),
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
   reply from Hercules with the run's read-only token until the completed
   message lands in Convex.
4. When a run ends, `onRunFinished` is called after the last write.

If nothing has been delivered for a run in three minutes, the component asks
Hercules for the run and its events itself, so a delivery that never arrives
only delays a reply.

### Methods

| Method                                                       | Where              | Does                                                             |
| ------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------- |
| `send(ctx, { threadId?, text, context?, anonymousId? })`     | mutation           | Sends the caller's message and starts a run                      |
| `run(ctx, { threadId?, text, context? })`                    | mutation or action | Starts a run as the app's own job, for no end user               |
| `readThread(ctx, { threadId, anonymousId?, limit? })`        | query              | The caller's thread: messages, the run going, its live stream    |
| `cancel(ctx, { threadId, anonymousId? })`                    | mutation           | Stops the run going on the caller's thread                       |
| `deleteThread(ctx, { threadId, anonymousId? })`              | mutation           | Deletes the thread here and at Hercules. Irreversible            |
| `claimPageAction(ctx, { threadId, runId, toolCallId, ... })` | mutation           | Takes a page action for one tab to run                           |
| `registerRoutes(http)`                                       | `convex/http.ts`   | Routes the events Hercules delivers. One route serves all agents |

A thread answers only to the user who opened it: anyone else reads `null`.
Failures throw a `ConvexError` whose `data` is `{ code, message,
retryAfterSeconds? }`, with `code` one of `sign_in_required`, `not_found`,
`thread_busy`, `end_user_rate_limited`, `message_too_long` and
`invalid_request`.

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

### Visitors

Set `allowAnonymous: true` to let visitors who are not signed in talk to the
agent. The page keeps an `anonymousId` for the visitor and passes it to
`send`, `thread` and the others. Hercules takes visitors only when the agent's
app access is public.

### Configuration

| Option                      | Default                                             |
| --------------------------- | --------------------------------------------------- |
| `apiKey`                    | `HERCULES_API_KEY`                                  |
| `apiUrl`                    | `HERCULES_API_URL`, then `https://api.hercules.app` |
| `issuer`                    | `HERCULES_OIDC_AUTHORITY`                           |
| `pageActions`               | none: the page actions every run may call           |
| `limits.runsPerUserPerHour` | no limit                                            |

A component cannot read the app's environment, so the app key travels to the
component's scheduled functions as an argument. It never reaches a browser.

## In React

```tsx
import { useAgentThread } from "@usehercules/agents/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

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
back to the run.

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
