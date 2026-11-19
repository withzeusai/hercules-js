---
"@usehercules/agents": major
---

1.0.0. The public API is stable, and from this release the package follows [semantic versioning](https://semver.org).

**What 1.0.0 means**

Within 1.x, an upgrade does not break an app that uses the public API as the README describes it. A change that would break one takes a new major version.

- **Covered:** the documented exports of `@usehercules/agents`, `/convex`, `/convex.config`, `/tanstack` and `/react`, with their options, their return values, their types and the error codes they name; the functions `support.api()` builds; what `onRunFinished` and a tool's handler are called with; the routes the package serves in the app; and the option defaults that decide who can call a tool or what a page sees. The README's "Versioning" lists each.
- **A minor version may:** add an export, an option, a field, or a value to an open set; change a limit or a timing the README marks as tuning; take a newer version of a peer, or raise the lowest version of one within the same major.
- **Not covered:** anything the entry points do not export, `@usehercules/agents/_generated/component`, the component's own functions and tables, what the package logs, and the exact requests it makes to Hercules.
- **What is stored:** a 1.x version reads what earlier 1.x versions stored, and what 0.3.0 stored. An upgrade is one-way: going back to an older version in a deployment a newer one has run in is not supported.
- **Peers:** `convex` `^1.49.0`, `react` `^18.0.0 || ^19.0.0`, `@tanstack/ai` `^1.2.0` and `@tanstack/ai-client` `^1.1.0`, each optional and needed only by the entry points that use it. `/tanstack` is built on TanStack AI 1.x.

**Upgrading from 0.3.0**

Nothing stored changes, and no default changes: a deployment that ran 0.3.0 upgrades in place, with no migration, and reads every thread it had. An app that uses the package as the README and the Hercules docs describe changes two things, the field names in (1) and `metadata.hercules.status` in (2). The rest of this list is complete: everything else that can need a code change is in it, and TypeScript flags each place.

**1. The thread's fields are camelCase**

What the package builds for an app uses one style of name. What is the Hercules API's own JSON keeps the API's names: the events `followRun` yields, the `Message` in a `message.completed`, and `Run` are unchanged.

| Where                                                                                                       | 0.3.0                               | 1.0.0                            |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| `thread.messages[]`, from `thread`, `readThread`, `readThreadDetails`, `useThreadSync` and `useAgentThread` | `thread_id`, `run_id`, `created_at` | `threadId`, `runId`, `createdAt` |
| `thread.activeRun`                                                                                          | `created_at`                        | `createdAt`                      |
| `thread.latestRun`                                                                                          | `finished_at`                       | `finishedAt`                     |
| `thread.pageActions[]`                                                                                      | `created_at`                        | `createdAt`                      |
| `readThreadDetails(...).toolCalls[]`                                                                        | `created_at`                        | `createdAt`                      |

**2. `metadata.hercules.status` is two fields**

In the TanStack path a message said one thing under `status`: where the thread had it, or how its run ended, depending on where the message came from. Now each has its own field, and a reply has both when its run is over.

| What you read                           | 0.3.0                                                  | 1.0.0                                                      |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| A reply that stopped before it finished | `metadata.hercules.status === "incomplete"`            | `metadata.hercules.messageStatus === "incomplete"`         |
| Where the thread has a message          | `status`: `streaming`, `completed`, `incomplete`       | `messageStatus`, with the same values                      |
| How a message's run ended               | `status`: `completed`, `failed`, `cancelled`, `capped` | `runStatus`, with the same values, on the run's last reply |

**3. Every set of values that can grow is open**

A `switch` over one of these needs a `default`. One that ended in an exhaustiveness check stops compiling, which is the point: it would have stopped the day a value was added. Comparing with a value you know, and narrowing on it, work as before.

| Set                                                                                                                                                   | 0.3.0                    | 1.0.0                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A run's status, the capped reason, a tool's kind, how a tool call ended, a message's role, an event's type name, `AgentErrorCode`, the kind of caller | A closed list of names   | The same names, or any string                                                                                              |
| An event, a message part, a tool's caller: unions told apart by a name                                                                                | One member for each name | One more member, for a name this version does not know. Its name is typed `UnknownName`: read it with `String(event.type)` |
| A thread message's `status` (and `messageStatus`), a page action's `status`, `useAgentThread`'s `status`                                              | A closed list of names   | The same names, or any string. These are the package's own: only a later version of the package adds one                   |

The four statuses a run ends with (`completed`, `failed`, `cancelled`, `capped`) stay a closed list. The README's "Open sets" says what a value you do not know means for each set.

**4. `followRun` hands each event on as Hercules sent it**

| What                                                       | 0.3.0                                                     | 1.0.0                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| An event of a type this version does not know              | Skipped                                                   | Yielded. A final one ends the loop after it is yielded            |
| A tool kind, tool status or capped reason it does not know | Rewritten to `hercules`, `failed`, `null`                 | Handed on as sent                                                 |
| An event's fields                                          | Rebuilt from the fields the package knew                  | Every field Hercules sent, `final` among them                     |
| A stream that closes at once with nothing new              | Counted as a failed connection, and thrown for in the end | A run that waits: `followRun` connects again, less and less often |

The thread, the hooks and `onRunFinished` read a value the package does not know as they did before.

**5. A tool is opaque**

| What                               | 0.3.0                                            | 1.0.0                                                                                            |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| What `tool()` returns              | An object whose fields could be read and changed | A value with nothing on it to read or change                                                     |
| What `defineTools` takes as a tool | Any object of that shape                         | Only a value `tool()` returned. One written by hand, or a copy, is refused when the module loads |
| What `defineTools` returns         | `registerRoutes`, `name`, `path`, `handle`       | `registerRoutes`                                                                                 |

`tool({...})` inside `defineTools({ tools: {...} })` is unchanged.

**6. A page action's arguments are `Record<string, unknown>`**

| What                                        | 0.3.0 | 1.0.0                                                             |
| ------------------------------------------- | ----- | ----------------------------------------------------------------- |
| A handler's first argument                  | `any` | `Record<string, unknown>`: check a value's type before you use it |
| A page action whose arguments are no object | Run   | Not run                                                           |

**7. A new thread's id is made at random**

| A `threadId` that names no thread yet                         | 0.3.0                                                 | 1.0.0                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| A UUID of version 4 or 7 in lowercase, or a ULID in uppercase | Opens the thread                                      | Opens the thread                                                     |
| Any other, such as a UUID derived from an order number        | Stored, then refused by Hercules when the run started | Refused by `send` with `invalid_request`, before anything is written |

Use `crypto.randomUUID()`. A thread that already exists keeps working under its id, whatever its form.

**8. Removed exports**

None of these was named in the README, the Hercules docs or the builder's skills.

| Entry point                    | Removed                                                                                                                                                                                                                                                                                                                                                                                                                                       | Use instead                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@usehercules/agents`          | The type `Event`                                                                                                                                                                                                                                                                                                                                                                                                                              | `AgentEvent`, the same type                                                 |
| `@usehercules/agents`          | `createMcpHandler`, `createTokenVerifier` and their types `McpTool`, `McpHandlerOptions`, `JsonSchema`, `TokenVerifier`, `TokenVerifierOptions`, `TokenResult`, `TokenFailure`, `VerifiedToken`                                                                                                                                                                                                                                               | `defineTools` and `tool` from `/convex`                                     |
| `@usehercules/agents`          | `bearerTokenOf`, `callerFromToken`, `deploymentOrigins`, `parseEventStream` and its `ServerSentEvent` type, `readAgentEvent`, `isFinalEvent`, `isFinalStatus`, and the constants `AGENT_ORIGINS_META_KEY`, `PRINCIPALS_META_KEY`, `SUPPORTED_PROTOCOL_VERSIONS`, `DEFAULT_API_URL`, `EVENTS_PATH`, `FINAL_EVENT_TYPES`, `HERCULES_API_VERSION`, `HIDDEN_TOOL_NAME`, `HIDDEN_TOOL_SUMMARY`, `HIDDEN_TOOL_FAILED_SUMMARY`, `PAGE_ACTION_TTL_MS` | `followRun` reads a stream; an event's `final` says whether it ends its run |
| `@usehercules/agents/convex`   | `validatorToJsonSchema`, and the type `ComponentApi`                                                                                                                                                                                                                                                                                                                                                                                          | Pass `components.herculesAgents` to `new HerculesAgents(...)`, as before    |
| `@usehercules/agents/react`    | `LiveRun`, `mergeThread`, and the type `PendingInput`                                                                                                                                                                                                                                                                                                                                                                                         | `useAgentThread`                                                            |
| `@usehercules/agents/tanstack` | `syncThread`, `threadToUIMessages`, and the types `SendArgs` and `ThreadQueryArgs`                                                                                                                                                                                                                                                                                                                                                            | `useThreadSync`, and `SendArgs` from `/convex`                              |

**9. Members of `HerculesAgents` that are no longer public**

| What                              | 0.3.0                       | 1.0.0                 |
| --------------------------------- | --------------------------- | --------------------- |
| `component`, `options`, `agentId` | Readable on an instance     | Gone, at run time too |
| `handleEvents`                    | `(ctx, request, verifier?)` | `(ctx, request)`      |

**10. What it runs on**

| What              | 0.3.0      | 1.0.0                                                       |
| ----------------- | ---------- | ----------------------------------------------------------- |
| The `convex` peer | `^1.29.0`  | `^1.49.0`, the version Hercules's app templates ship        |
| Node              | Not stated | 22 or later (`engines`), the lowest its Convex peer runs on |

The `react`, `@tanstack/ai` and `@tanstack/ai-client` peers are unchanged.
