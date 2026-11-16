---
"@usehercules/agents": patch
---

Make stopping a reply hold together.

- A message sent right after `chat.stop()` is no longer refused as `thread_busy`: `herculesConnection` waits for the stopped run to end, for `settleTimeoutMs` at most, and then sends it. The thread says a stop is on its way with the new `activeRun.stopping`, for a page that would rather hold its Send button.
- A stop that Hercules had not finished when it answered is asked for again within seconds, not at the stuck-run check three minutes later.
- The reply a page streamed before a stop stays in the chat: `useThreadSync` keeps it, with `metadata.hercules.status` set to `"incomplete"`, when the thread holds less of it. The thread itself keeps the reply up to its last checkpoint: the component now reads what the run wrote before it records the stop, and a checkpoint delivered after the stop reads as `incomplete`, not as `streaming` for good.
- A run that was asked to stop and that Hercules ends as `failed` with the code `run_failed` is recorded as `cancelled`, so a page does not report an error for a reply its user stopped.
- `visitorId` on an `agent` tool caller is deprecated. Agents no longer take anonymous visitors; it is still set for a thread a visitor opened before that.
