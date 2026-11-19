---
"@usehercules/agents": minor
---

Settle the package's public surface: what is exported, what is promised, and what is not.

This release makes the public API small and writes it down, so that a later 1.0.0 can freeze it as it is once it has run in real apps. The package is still at 0.x: a 0.x minor version may contain breaking changes, and this one does. Keep pinning an exact version.

**Breaking: the thread's fields are camelCase.** What the package builds for an app now uses one style of name. Rename these where your code reads them:

| Where                                                                                                       | 0.3.0                               | 0.4.0                            |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| `thread.messages[]`, from `thread`, `readThread`, `readThreadDetails`, `useThreadSync` and `useAgentThread` | `thread_id`, `run_id`, `created_at` | `threadId`, `runId`, `createdAt` |
| `thread.activeRun`                                                                                          | `created_at`                        | `createdAt`                      |
| `thread.latestRun`                                                                                          | `finished_at`                       | `finishedAt`                     |
| `thread.pageActions[]`                                                                                      | `created_at`                        | `createdAt`                      |
| `readThreadDetails(...).toolCalls[]`                                                                        | `created_at`                        | `createdAt`                      |

Nothing stored changes: the component's tables already used these names, so a deployment that ran 0.3.0 upgrades in place, with no migration, and reads every thread it had. TypeScript flags each place that reads an old name.

What is the Hercules API's own JSON keeps the API's names, as the API reference documents them: the events `followRun` yields (`AgentEvent`, and the `Message` in a `message.completed`) and the `Run` type are unchanged. So are `RunFinished` and every option, which were camelCase already, and so is your own data: tool arguments and results, page-action arguments and `context` are never renamed. The README's "Naming" states the rule.

**Breaking: every set of values Hercules can add to is open in the types.** A run's status, the capped reason, a tool's kind, how a tool call ended, a message's role, the name of an event type, `AgentErrorCode` and the kind of caller now take any string beside the names this version knows. An event, a message part and a tool's caller, which are told apart by a name, each have one more member for the names this version does not know. So a `switch` over one of them needs a `default`: one that ended in an exhaustiveness check stops compiling, which is the point, since it would have stopped compiling the day a value was added. Narrowing on a known name works as before. The name of the unknown member is typed `UnknownName` and read with `String(...)`. The four statuses a run ends with stay a closed list. The README lists every open set, with what a value you do not know means.

**Breaking: `followRun` hands each event on as Hercules sent it.** It used to rebuild each event from the fields it knew. Now nothing is renamed, left out or rewritten, on the event or inside it, so a field, a part type or a value the API adds reaches the app as sent. Every event has `final`, and `AgentEvent` types it. An event of a type this version does not know is yielded, where it was skipped, and a final one ends the loop after it is yielded. A tool kind, a tool status or a capped reason this version does not know is no longer rewritten to `hercules`, `failed` or `null` in what `followRun` yields. The thread, the hooks and `onRunFinished` read them as before. A stream that closes at once with nothing new is a run that waits, not a failed connection: `followRun` connects again, less and less often, and no longer throws for it.

**Breaking: a tool is opaque.** What `tool()` returns has nothing on it to read or to change, and `defineTools` takes only values `tool()` returned: a tool written by hand, or a copy of one, is refused when the module loads. `tool({...})` inside `defineTools({ tools: {...} })` is unchanged.

**Breaking: a page action's arguments are `Record<string, unknown>`**, not `any`. A handler has to check a value's type before it uses it, as the documented ones do. A page action whose arguments are not an object is not run.

**Breaking: `metadata.hercules.status` is two fields.** In the TanStack path a message has `messageStatus` (where the thread has it: `streaming`, `completed`, `incomplete`) when it was read from the thread, or `runStatus` (how its run ended) when this page streamed it. Read `messageStatus === "incomplete"` where you read `status === "incomplete"`.

**Breaking: a new thread's id has to be made at random.** `send` opens a new thread only under a random UUID (version 4, as `crypto.randomUUID()` makes, or version 7) in lowercase, or a ULID in uppercase, which is the rule Hercules applies. A UUID of another version, such as one derived from an order number, is refused with `invalid_request` before anything is written, where it used to be refused by Hercules after the message was stored. A thread that already exists keeps working under its id, whatever its form.

**Breaking: removed from the public exports.** None of these was named in the README, the Hercules docs or the builder's skills. An app that imports one has to stop before it upgrades:

- From `@usehercules/agents`: `createMcpHandler`, `createTokenVerifier` and their types `McpTool`, `McpHandlerOptions`, `JsonSchema`, `TokenVerifier`, `TokenVerifierOptions`, `TokenResult`, `TokenFailure` and `VerifiedToken`; the type `Event` (use `AgentEvent`, the same type); `bearerTokenOf`, `callerFromToken`, `deploymentOrigins`, `parseEventStream` and its `ServerSentEvent` type, `readAgentEvent`, `isFinalEvent`, `isFinalStatus`; and the constants `AGENT_ORIGINS_META_KEY`, `PRINCIPALS_META_KEY`, `SUPPORTED_PROTOCOL_VERSIONS`, `DEFAULT_API_URL`, `EVENTS_PATH`, `FINAL_EVENT_TYPES`, `HERCULES_API_VERSION`, `HIDDEN_TOOL_NAME`, `HIDDEN_TOOL_SUMMARY`, `HIDDEN_TOOL_FAILED_SUMMARY` and `PAGE_ACTION_TTL_MS`.
- From `@usehercules/agents/convex`: `validatorToJsonSchema`, and the `ComponentApi` type: pass `components.herculesAgents` to `new HerculesAgents(...)` as before.
- From `@usehercules/agents/react`: `LiveRun`, `mergeThread` and the `PendingInput` type.
- From `@usehercules/agents/tanstack`: `syncThread`, `threadToUIMessages`, and the types `SendArgs` and `ThreadQueryArgs`.

**Breaking: members that are no longer public.**

- `HerculesAgents`: `component`, `options` and `agentId` are gone, at run time too. `handleEvents(ctx, request)` no longer takes a third argument.
- What `defineTools` returns has `registerRoutes` only. Its `name`, `path` and `handle` are gone.

**Breaking: the `convex` peer is `^1.49.0`**, the version Hercules's app templates ship and the one the package is tested with. It was `^1.29.0`.

**Still exported, under the same names**: `HerculesAgents`, `runFinishedValidator`, `defineTools`, `tool`, `ToolError`, `herculesConnection`, `useThreadSync`, `agentErrorCode`, `PAGE_ACTION_OUTPUT`, `PROGRESS_EVENT`, `useAgentThread`, `AgentError`, `RunStreamError`, `followRun`, and the types that go with them. An app that uses the package as the README and the Hercules docs describe changes two things: the field names above, and `messageStatus` where it read `metadata.hercules.status`. No default changes, and the component's tables and stored documents are untouched, so an upgrade keeps every thread.

**One addition on the wire.** The page's request for a run's live stream now carries `Hercules-Client: agents/<version>`, as every request the app's backend makes has since 0.3.0. Hercules accepts the header from a page, so there is nothing to do in an app. A `fetch` you pass to `herculesConnection`, `useAgentThread` or `followRun` sees one more request header.

**Two facts about Hercules, now stated.**

- Hercules sends a `final` field on every event: `true` on the event that ends its run, `false` on every other. The package has read it since 0.3.0, so a final event of a type added later ends its run, and `followRun` now hands it on with each event.
- Hercules signs one more origin for a run with no end user: `other`, for a run it does not put under another name. The `AgentOrigin` type names it and the README lists it. As before, a tool that lists `"agent"` takes the origin `app` only: `other` is refused unless the tool lists it in `agentOrigins`, which is wise only for a tool that is safe for anyone who can reach the agent. An origin the package does not know is not read as `other`.

**Also in this release.**

- `UnknownName` is exported from each entry point whose types use it.
- The declarations carry their doc comments, so an editor shows that `run` is server-only, that `apiKey` must not reach a browser and that a page action's arguments are untrusted.
- `package.json` has `engines`: Node 22 or later, the lowest its Convex peer runs on.
- The `/react` types no longer need `convex` installed to resolve, and `herculesConnection(convex, api.agent)` compiles under `exactOptionalPropertyTypes`.
- `runFinishedValidator` takes any string as `cappedReason`.

**The README says what is promised.**

- "Versioning" says what the public API is and what it is not, that 0.x minors may break, what will hold from 1.0.0, what may change in a minor version, and what the package runs on. It lists the open sets and every error code the package writes itself, `http_<status>` and `send_failed` among them.
- `chat.reload()` in the TanStack path sends the last user message again as a new, charged run. There is no regenerate: do not wire a button to it.
- "Defaults and limits" states, once, what every option is when left out and the limits an app is designed around: a message's length, the size of a thread read, and the page-action expiry. How the package recovers (when it asks again, how long before it gives up) is described by what it achieves, without its timing, which is the package's own to tune.
- A reply that was stopped while it was written is kept as far as it was written, as a `completed` message, in the thread, in another tab and after a reload. The README said it was kept "up to its last checkpoint", as `incomplete`. `incomplete` is the status of a reply whose run ended before the app got it whole.
