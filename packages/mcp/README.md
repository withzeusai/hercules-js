# @usehercules/mcp

Serve an MCP server from a Hercules app. Declare tools next to your backend
functions, and Hercules Auth decides who is calling them.

The package has no runtime dependencies. It verifies tokens with Web Crypto
and speaks MCP over stateless Streamable HTTP, so it fits in a Convex HTTP
action.

## Convex

```ts
// convex/mcp.ts
import { defineMcpServer, tool } from "@usehercules/mcp/convex";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const mcp = defineMcpServer({
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
import { mcp } from "./mcp";

const http = httpRouter();
mcp.registerRoutes(http);
export default http;
```

The server is at `https://<deployment>.convex.site/mcp`.

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
- `v.int64()` travels as a decimal string and `v.bytes()` as base64.

## Errors

Throw `McpToolError` or a `ConvexError` with a string to tell the model what
went wrong in words it can act on. Any other error is logged and reaches the
model as a generic failure, so internal detail does not leak.

## Several servers

Name each server when the app splits its tools by data or risk. Each gets its
own URL, and a token issued for one is refused by the others.

```ts
export const support = defineMcpServer({ name: "support", tools: { ... } }); // /mcp/support
export const billing = defineMcpServer({ name: "billing", tools: { ... } }); // /mcp/billing
```

## How tokens are checked

A request must carry an RS256 JWT signed by the app's Hercules Auth
(`HERCULES_OIDC_AUTHORITY`), issued for this server's own URL
(`CONVEX_SITE_URL` plus the path), and not expired. Keys come from the
issuer's OpenID discovery document and are cached for five minutes.

Pass `issuer` or `audiences` to `defineMcpServer` to override either.

## Other backends

`@usehercules/mcp` exports the backend-neutral core (`createMcpHandler`,
`createTokenVerifier`): a function from a web `Request` to a `Response`. An
adapter supplies the tools and the context their handlers receive.

## Not supported yet

Server-sent events, resources, prompts, sampling and elicitation.
