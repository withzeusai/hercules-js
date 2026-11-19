---
"@usehercules/agents": patch
---

With `@usehercules/agents/tanstack`, a reply says the same of itself when its run ends as it does after a reload.

A page marks a reply from its `metadata.hercules`: `messageStatus` is `"incomplete"` on a reply that stopped before it finished, and `runStatus` says how its run ended. In 0.3.0 a reply the page streamed said how its run ended and a reloaded reply said where the thread had it, so a mark made from either showed live or after a reload, not both.

- When a run ends, its last reply has both `messageStatus` and `runStatus`, whether the run completed, failed, was stopped or was capped. A run that ended in a way this version does not know reads as `failed`.
- After a reload the reply reads the same: the last reply of the thread's latest run has `runStatus` too. The thread keeps how its latest run ended and no earlier one, so an older reply has `messageStatus` alone.
- When a run ends and the thread holds less of its reply than the page streamed, the page's text stays in the chat with `messageStatus` set to `"incomplete"`, as the README says. Before, the text could go back to what the thread held.
- `useThreadSync` also puts the thread into the chat when the page's stream ends, not only when the thread changes. When only a reply's `metadata.hercules` differs, it sets that and keeps the chat's own messages.

`useAgentThread` (`@usehercules/agents/react`) already read the thread at the run's end, so its messages and `thread.latestRun` were the same live and after a reload. Tests now hold it to that.
