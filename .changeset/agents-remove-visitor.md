---
"@usehercules/agents": minor
---

Remove `visitorId` from the `agent` tool caller, give a run refused for want of Hercules Auth 2.0 a clear error, and keep a second tab in step with a run it did not start.

- **Breaking for an app that reads `caller.visitorId`:** the field is gone from `ToolCaller`. Agents take no anonymous visitors, and the field was deprecated in 0.1.1. The package is not at 1.0 and Hercules apps pin its exact version, so this ships as a minor version. Delete the read: an `agent` caller has no end user. A token that still carries the `hercules_visitor` claim verifies as before and reads as that same `agent` caller.
- A run Hercules refuses as `hercules_auth_required` (the app has no Hercules Auth 2.0 tenant, so Hercules cannot deliver the run's events to it or call its tools) fails at once and is not sent again. Its error tells the developer to upgrade the app to Hercules Auth 2.0: in the Convex logs, in `onRunFinished` and in `readThreadDetails`. The thread a page reads has the same code with the message "The assistant is not available right now." A code the package does not know still fails the run with the message Hercules sent.
- `useThreadSync` follows a run another tab started through every update of the thread. It stopped after the first one: the message that started the run carries the run's id, which was taken to mean that this page streamed the run. What this page streamed is still left alone until Convex has the run's end.
