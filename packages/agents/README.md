# @usehercules/agents

Hercules agents in a Hercules app. This release covers app tools: declare
tools next to your backend functions, serve them to Hercules agents as an MCP
server, and let Hercules Auth decide who is calling them.

The package has no runtime dependencies. It verifies tokens with Web Crypto
and speaks MCP over stateless Streamable HTTP, so it fits in a Convex HTTP
action.

## Convex

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

## Who is calling

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

## Arguments and results

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

## Errors

Throw `ToolError` or a `ConvexError` with a string to tell the model what
went wrong in words it can act on. Any other error is logged and reaches the
model as a generic failure, so internal detail does not leak.

## Several servers

Name each set of tools when the app splits them by data or risk. Each is its
own MCP server with its own URL, and a token issued for one is refused by the
others.

```ts
export const supportTools = defineTools({ name: "support", tools: { ... } }); // /mcp/support
export const billingTools = defineTools({ name: "billing", tools: { ... } }); // /mcp/billing
```

## How tokens are checked

A request must carry an RS256 JWT signed by the app's Hercules Auth
(`HERCULES_OIDC_AUTHORITY`), issued for this server's own URL, and not
expired. It must say who is calling in its `hercules_principal` claim: a
token without one is refused. Keys come from the issuer's OpenID discovery
document and are cached for five minutes. While they cannot be fetched the
server answers 503 with `Retry-After`, never 401: that says nothing about the
token.

Hercules calls a server at `/mcp`, or `/mcp/<name>` for a named one, on the
deployment's own `https://<name>.convex.site`, and signs its tokens for that
URL. So the server takes a token for its path on `CONVEX_SITE_URL`, and on
the `.convex.site` origin that goes with `CONVEX_CLOUD_URL`: a deployment that
points `CONVEX_SITE_URL` at a custom domain keeps working. A deployment that
overrides both variables must pass `audiences` to `defineTools` with its
`https://<name>.convex.site/mcp` URL, or every call is refused with 401.

Pass `issuer` or `audiences` to `defineTools` to override either.

## Other backends

`@usehercules/agents` exports the backend-neutral core (`createMcpHandler`,
`createTokenVerifier`): a function from a web `Request` to a `Response`. An
adapter supplies the tools and the context their handlers receive.

## Not supported yet

Server-sent events, resources, prompts, sampling and elicitation.
