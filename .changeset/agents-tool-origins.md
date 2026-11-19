---
"@usehercules/agents": minor
---

A tool that lists `"agent"` in `principals` now takes a call with no end user only from the app's own job, unless it says otherwise.

- **Breaking for a tool that lists `"agent"` and is called by anything but the app's own job.** Hercules signs where a run with no end user was started into its tokens, as the claim `hercules_origin`: `app` (the app's own backend started the run with its app key and no end user), `organization`, `console`, `trigger`, `channel`, `schedule` or `test`. A tool that lists `"agent"` used to take every one of them. It now takes `app` alone. A call whose token names another origin, an origin the package does not know, or no origin at all is refused, and the tool is not listed to that caller. The package is not at 1.0 and Hercules apps pin its exact version, so this ships as a minor version.
- **To keep the old behavior for a tool, add one line to it: `agentOrigins: "any"`.** To take only some origins, list them: `agentOrigins: ["app", "schedule"]`.
- `agentOrigins` is only for a tool that lists `"agent"`. On any other tool it is a type error, and `defineTools` throws when the module loads. An empty list throws too.
- The `agent` caller a handler receives has a new field, `origin`: the origin Hercules signed, or `null` when the token names none. `AgentOrigin` is its type.
- A signed-in user's calls are not affected, with an agent acting for them or not.
- An inspection listing carries each agent tool's origins beside its principals, under `hercules.app/agent-origins`.
