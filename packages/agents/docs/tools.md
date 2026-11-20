# App tools

How to give a Hercules agent the app's own tools with `defineTools` and
`tool` from `@usehercules/agents/convex`: who a tool's caller can be, where
its result goes, and what an app has to know before it relies on them.

The [README](../README.md) is the reference: "App tools" there has the first
tool, how it is routed, the `caller` object, `principals` and `agentOrigins`,
and how each call is checked, and "Versioning" says what the package
promises. This guide adds no promise of its own. Where it describes what
Hercules does, that is for context, and is Hercules's to define.

The other guides: [The Convex side](./convex.md), [The chat](./chat.md) and
[Events, limits and errors](./events-and-errors.md).

## Writing a tool

- **A tool's name** uses letters, digits, `_` and `-`, and is at most 64
  characters. `defineTools` throws on any other when the module loads, so a
  mistake fails the deploy and not the first call.
- **A handler's `ctx`** has `runQuery`, `runMutation` and `runAction`, to
  call the app's own functions. Nothing else of Convex's context is offered,
  and there is no `ctx.auth`: the caller is the handler's third argument.
- **The path is fixed.** The tools are served at `/mcp` on the deployment's
  `.convex.site` address, or at `/mcp/<name>` for a named server. That is
  where Hercules calls.
- **Export the tools as `tools`**, not as `support`: `convex/agent.ts`
  exports the agent under that name, and `convex/http.ts` imports both.
- **The app needs Hercules Auth 2.0.** Hercules signs each call with the
  app's own Hercules Auth. Without it the agent cannot use the app's tools.
- **`returns` is the list of fields an agent may see.** Declare it on any
  tool that reads user data.

## A tool for both callers

A tool that lists both `"user"` and `"agent"` is called for a signed-in
user, and by the app's own job with no user. Its handler has to handle both,
and reads which it is from `caller.principal`:

<!-- sample: convex/tools.ts -->

```ts
// convex/tools.ts
import { defineTools, tool, ToolError } from "@usehercules/agents/convex";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const tools = defineTools({
  tools: {
    list_open_tasks: tool({
      description:
        "Lists open tasks: the signed-in user's own, or everyone's for the app's own job.",
      args: { limit: v.optional(v.number()) },
      // Also the list of fields an agent may see: anything else is removed.
      returns: v.object({ tasks: v.array(v.object({ id: v.string(), title: v.string() })) }),
      annotations: { readOnlyHint: true },
      // Signed-in users, and the app's own job: `agentOrigins` is `["app"]` when left out.
      principals: ["user", "agent"],
      handler: async (ctx, args, caller) => {
        const limit = args.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          // The model reads this, and can call again.
          throw new ToolError("limit must be a whole number from 1 to 50.");
        }
        // Who is asking comes from the verified caller, never from the arguments.
        if (caller.principal === "user") {
          return await ctx.runQuery(internal.tasks.openFor, {
            tokenIdentifier: caller.tokenIdentifier,
            limit,
          });
        }
        // The app's own job: `caller.origin` is "app".
        return await ctx.runQuery(internal.tasks.openForAll, { limit });
      },
    }),
  },
});
```

- Pass the caller on to an internal function. Never take a user's id from
  the tool's arguments: the model writes those.
- Throw `ToolError`, or a `ConvexError` with a string, to tell the model what
  was wrong in words it can act on.
- `internal.tasks.openFor` and `internal.tasks.openForAll` are internal
  queries of the app's own, which return `{ tasks }`.

## Who the caller can be

- **A `"user"` caller is the end user this app started the run for**, with
  `send`. Hercules names a user to an app's tools for nothing else.
- **A turn someone else adds to a user's thread is not that user asking.** A
  thread outlives the run that opened it, and Hercules can take a later
  message on it from somewhere else: from the Hercules console, or from a run
  started with an Organization API key. Such a turn reaches the app's tools
  neither as the user nor as `"agent"`: it gets none of the app's tools.
- **A run another app started for one of its own users** gets none of this
  app's tools either: this app cannot be told who that user is.
- **A subagent** has the caller of the run that started it, or none where
  that run has none.
- **An `"agent"` caller is a run that acts for no end user**, and
  `caller.origin` says where it was started. A tool that lists `"agent"`
  takes the app's own job only, the origin `"app"`, unless `agentOrigins`
  names more. "Where a run with no end user was started" in the README has
  the origins and the rule for one this version does not know.

## Users another sign-in method signed in

The app's tools are not available to a run started for a user the app's own
Hercules Auth did not sign in. The agent still answers, with its other
tools.

- Hercules signs each call with the app's Hercules Auth, so it can name only
  the users that Hercules Auth signed in.
- Such a run does not reach the tools as `"agent"` instead. That caller
  means no person is behind the call.
- To give those users the app's tools, sign them in with Hercules Auth, so
  that the `tokenIdentifier` Convex gives `send` is the one Hercules Auth
  issued.

## Where a result goes

- To the agent, which reads it to write its reply.
- To the app's backend. The component stores it, and `readThreadDetails`
  returns it as the call's `resultJson`: see "What the agent's tools did" in
  [The Convex side](./convex.md#what-the-agents-tools-did).
- Not to the chat. `thread` and the chat hooks show the tool's name and a
  one-line summary, such as "Ran create task", and never its result.
- Not to the browser at all, by default. With `exposeToolDetails: true` the
  run's live stream carries each result to the browser, where the user can
  read it, though the chat still does not show it.

## Other code that checks tokens

Every token Hercules sends the app is signed by the app's own Hercules Auth,
the issuer that also signs its users' session tokens, with the same keys.
The package's routes check the tokens they are sent for you: the issuer, the
audience, which is the exact URL Hercules called (the tool server's, or the
events route's), and the caller in `hercules_principal`.

If the app verifies that issuer's tokens anywhere else by hand, in another
HTTP route or another service, that code should check that `aud` is the
audience it expects. It can also check the token's type: every token
Hercules sends the app carries `typ: "hercules-app+jwt"` in its header, and
a user's session token carries no such `typ`. A token made for the tools
server is then never taken for anything else.

## Several servers

"Several servers" in the README shows how to split tools by data or risk. A
server's name uses lowercase letters, digits and dashes, and decides its
path: `/mcp/<name>`. Call `registerRoutes(http)` on each set in
`convex/http.ts`.

## Which deployment is called

Current behavior of Hercules, which may change without notice, so do not
build on it:

- An agent's tool calls go to the app's production deployment, whichever
  deployment's key started the run. A run started from another deployment,
  a development one say, has its events delivered to that deployment and
  its tool calls made to production. So a chat tried on another deployment
  reads and writes production data through its tools, and does not see
  tools that exist only there.
- A test of the agent from Hercules's app builder is the exception: it calls
  the tools of the backend the builder builds against.

## Not supported

- **A backend that is not Convex.** This release serves tools from Convex
  only. How Hercules talks to a tools server is not part of the package's
  public API, so a server written by hand against it is not supported.
- **Server-sent events, resources, prompts, sampling and elicitation.** A
  tool server serves tools, and answers each call in one response.
