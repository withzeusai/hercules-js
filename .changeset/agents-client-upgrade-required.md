---
"@usehercules/agents": patch
---

Reserve the error code `client_upgrade_required`, for the day Hercules no longer takes requests from a version of this package. Hercules does not send it today.

- A start answered with it fails the run at once, with that code, and is not sent again, whatever HTTP status carries it (426 or 400).
- A run that was going is failed the first time Hercules answers for it with the code, and a deleted thread is no longer asked about.
- The run's stored error, the Convex log and `onRunFinished` tell the developer to upgrade `@usehercules/agents`, with what Hercules said. The thread a page reads carries the same code with "The assistant is not available right now.", as for `hercules_auth_required`.
- `followRun` throws a `RunStreamError` with the code at once, as for any refusal.
