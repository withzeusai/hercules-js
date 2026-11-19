---
"@usehercules/agents": major
---

1.0.0: the package's API is stable.

From this version `@usehercules/agents` follows semantic versioning. What an app may count on is written down in the README: "Versioning" says what the public API is and what it is not, and "Defaults and limits" states every default, limit and time once. Removing or changing any of it takes a new major version. Keep pinning an exact version, as the apps Hercules builds do.

**Nothing changes for an app on 0.3.0** that uses the package as the README and the Hercules docs describe it. Its Convex functions, its chat and its tools run as they did. No default changes, and the component's tables and stored documents are untouched, so an upgrade keeps every thread.

**Removed from the public exports.** These were exported only because another part of the package uses them, and were documented nowhere. An app that imports one has to stop before it upgrades:

- From `@usehercules/agents`: `bearerTokenOf`, `callerFromToken`, `deploymentOrigins`, `parseEventStream` and its `ServerSentEvent` type, `readAgentEvent`, `isFinalEvent`, `isFinalStatus`, and the constants `AGENT_ORIGINS_META_KEY`, `PRINCIPALS_META_KEY`, `SUPPORTED_PROTOCOL_VERSIONS`, `DEFAULT_API_URL`, `EVENTS_PATH`, `FINAL_EVENT_TYPES`, `HERCULES_API_VERSION`, `HIDDEN_TOOL_NAME`, `HIDDEN_TOOL_SUMMARY`, `HIDDEN_TOOL_FAILED_SUMMARY` and `PAGE_ACTION_TTL_MS`.
- From `@usehercules/agents/convex`: `validatorToJsonSchema`.
- From `@usehercules/agents/react`: `LiveRun`, `mergeThread` and the `PendingInput` type.
- From `@usehercules/agents/tanstack`: `syncThread` and `threadToUIMessages`.

Everything the README, the Hercules docs and the builder's skills name is still exported under the same name: `HerculesAgents`, `runFinishedValidator`, `defineTools`, `tool`, `ToolError`, `herculesConnection`, `useThreadSync`, `agentErrorCode`, `PAGE_ACTION_OUTPUT`, `useAgentThread`, `AgentError`, `RunStreamError`, `followRun`, `createMcpHandler`, `createTokenVerifier`, and the types that go with them.

**One addition on the wire.** The page's request for a run's live stream now carries `Hercules-Client: agents/<version>`, as every request the app's backend makes has since 0.3.0. Hercules accepts the header from a page, so there is nothing to do in an app. A `fetch` you pass to `herculesConnection`, `useAgentThread` or `followRun` sees one more request header.

**The README is corrected** where it described a stopped reply. A reply that was stopped while it was written is kept as far as it was written, as a `completed` message, in the thread, in another tab and after a reload. It said the reply was kept "up to its last checkpoint", as `incomplete`. `incomplete` is the status of a reply whose run ended before the app got it whole, such as a run that failed while it was writing.
