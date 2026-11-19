---
"@usehercules/agents": minor
---

What is new since 0.3.0 and needs no change in an app.

**The page names the package to Hercules.** The page's request for a run's live stream carries `Hercules-Client: agents/<version>`, as every request the app's backend makes has since 0.3.0. Hercules accepts the header from a page, so there is nothing to do in an app. A `fetch` you pass to `herculesConnection`, `useAgentThread` or `followRun` sees one more request header.

**Two facts about Hercules, now stated and typed.**

- Hercules sends a `final` field on every event: `true` on the event that ends its run, `false` on every other. The package has read it since 0.3.0, so a final event of a type added later ends its run. `AgentEvent` now types it, and `followRun` hands it on with each event.
- Hercules signs one more origin for a run with no end user: `other`, for a run it does not put under another name. The `AgentOrigin` type names it and the README lists it. As before, a tool that lists `"agent"` takes the origin `app` only: `other` is refused unless the tool lists it in `agentOrigins`, which is wise only for a tool that is safe for anyone who can reach the agent. An origin the package does not know is not read as `other`.

**Types.**

- `UnknownName` is exported from each entry point whose types use it.
- The declarations carry their doc comments, so an editor shows that `run` is server-only, that `apiKey` must not reach a browser and that a page action's arguments are untrusted.
- The `/react` types no longer need `convex` installed to resolve, and `herculesConnection(convex, api.agent)` compiles under `exactOptionalPropertyTypes`.
- `runFinishedValidator` takes any string as `cappedReason`.

**The README says what is promised.**

- "Versioning" says what the public API is and what it is not, what a minor version may change, and what the package runs on. It names every export and every type, lists the open sets with what a value you do not know means, and lists every error code the package writes itself, `http_<status>` and `send_failed` among them.
- "Defaults and limits" states, once, what every option is when left out and the limits an app is designed around: a message's length, the size of a thread read, and the page-action expiry. How the package recovers (when it asks again, how long before it gives up) is described by what it achieves, without its timing, which is the package's own to tune.
- `chat.reload()` in the TanStack path sends the last user message again as a new, charged run. There is no regenerate: do not wire a button to it.
- A reply that was stopped while it was written is kept as far as it was written, as a `completed` message, in the thread, in another tab and after a reload. The README said it was kept "up to its last checkpoint", as `incomplete`. `incomplete` is the status of a reply whose run ended before the app got it whole.
