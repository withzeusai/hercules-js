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

**Breaking: removed from the public exports.** None of these was named in the README, the Hercules docs or the builder's skills. An app that imports one has to stop before it upgrades:

- From `@usehercules/agents`: `createMcpHandler`, `createTokenVerifier` and their types `McpTool`, `McpHandlerOptions`, `JsonSchema`, `TokenVerifier`, `TokenVerifierOptions`, `TokenResult`, `TokenFailure` and `VerifiedToken`; the type `Event` (use `AgentEvent`, the same type); `bearerTokenOf`, `callerFromToken`, `deploymentOrigins`, `parseEventStream` and its `ServerSentEvent` type, `readAgentEvent`, `isFinalEvent`, `isFinalStatus`; and the constants `AGENT_ORIGINS_META_KEY`, `PRINCIPALS_META_KEY`, `SUPPORTED_PROTOCOL_VERSIONS`, `DEFAULT_API_URL`, `EVENTS_PATH`, `FINAL_EVENT_TYPES`, `HERCULES_API_VERSION`, `HIDDEN_TOOL_NAME`, `HIDDEN_TOOL_SUMMARY`, `HIDDEN_TOOL_FAILED_SUMMARY` and `PAGE_ACTION_TTL_MS`.
- From `@usehercules/agents/convex`: `validatorToJsonSchema`.
- From `@usehercules/agents/react`: `LiveRun`, `mergeThread` and the `PendingInput` type.
- From `@usehercules/agents/tanstack`: `syncThread`, `threadToUIMessages`, and the types `SendArgs` and `ThreadQueryArgs`.

**Breaking: members that are no longer public.**

- `HerculesAgents`: `component`, `options` and `agentId` are gone from its public members. `handleEvents(ctx, request)` no longer takes a third argument.
- What `defineTools` returns has `registerRoutes` only. Its `name`, `path` and `handle` are gone.

**Breaking: the `convex` peer is `^1.49.0`**, the version Hercules's app templates ship and the one the package is tested with. It was `^1.29.0`.

**Still exported, under the same names**: `HerculesAgents`, `runFinishedValidator`, `defineTools`, `tool`, `ToolError`, `herculesConnection`, `useThreadSync`, `agentErrorCode`, `PAGE_ACTION_OUTPUT`, `PROGRESS_EVENT`, `useAgentThread`, `AgentError`, `RunStreamError`, `followRun`, and the types that go with them. An app that uses the package as the README and the Hercules docs describe changes nothing but the field names above. No default changes, and the component's tables and stored documents are untouched, so an upgrade keeps every thread.

**One addition on the wire.** The page's request for a run's live stream now carries `Hercules-Client: agents/<version>`, as every request the app's backend makes has since 0.3.0. Hercules accepts the header from a page, so there is nothing to do in an app. A `fetch` you pass to `herculesConnection`, `useAgentThread` or `followRun` sees one more request header.

**Two facts about Hercules, now stated.**

- Hercules sends a `final` field on every event: `true` on the event that ends its run, `false` on every other. The package has read it since 0.3.0, so a final event of a type added later ends its run. Nothing changes in an app.
- Hercules signs one more origin for a run with no end user: `other`, for a run it does not put under another name. The `AgentOrigin` type names it and the README lists it. As before, a tool that lists `"agent"` takes the origin `app` only: `other` is refused unless the tool lists it in `agentOrigins`, which is wise only for a tool that is safe for anyone who can reach the agent. An origin the package does not know is not read as `other`.

**The README says what is promised.**

- "Versioning" says what the public API is and what it is not, that 0.x minors may break, and what will hold from 1.0.0.
- "Defaults and limits" states, once, what every option is when left out and the limits an app is designed around: a message's length, the size of a thread read, and the page-action expiry. How the package recovers (when it asks again, how long before it gives up) is described by what it achieves, without its timing, which is the package's own to tune.
- A reply that was stopped while it was written is kept as far as it was written, as a `completed` message, in the thread, in another tab and after a reload. The README said it was kept "up to its last checkpoint", as `incomplete`. `incomplete` is the status of a reply whose run ended before the app got it whole.
