---
"@usehercules/agents": patch
---

Read what the API adds later without dropping what is known, in the app's backend and in the page.

- A tool call of a kind the package does not know is kept, as a `hercules` tool call: the kind whose name and summary a page is not shown unless the app set `exposeToolDetails`. It used to be left out of its message, and its `tool_call.completed` was not stored.
- A tool call that ended with a status the package does not know is kept, with the status `failed`: it is not known to have worked. It used to be left out of its message.
- The events `followRun`, `useAgentThread` and `herculesConnection` read from a run's live stream are now read as the delivered ones are. A completed message holds only parts of the types the package knows, so a part type added later is no longer taken for a tool call. A `run.failed` always carries an `error`, and a `run.capped` with a reason the package does not know carries `capped_reason: null` (its type is now `CappedReason | null`). Fields the package does not know are passed on as they came.
- `followRun` resumes after an event of a type it does not know, follows a run that is quiet for a long time without counting the streams Hercules closes as failures, and passes a finished run's reply on once however often Hercules sends it again.
- An event of a type the package does not know that Hercules marks with `final: true` ends its run, here as `failed` with the code `run_failed` and with what the run wrote. No event carries the mark today.
- A `run.progress` label, an error message and an error code are cut to a length a document can hold.
