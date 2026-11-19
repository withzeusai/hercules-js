---
"@usehercules/agents": patch
---

Handle an answer from Hercules by its HTTP status when the package has no rule for its code, and add the code `agent_unavailable`.

- `agent_unavailable` (403) fails a run at once and is not sent again. It is the app's setup: the agent is turned off, is not open to apps, has no owner, or its organization is suspended. The run's stored error tells the developer what to check, with what Hercules said, and the thread a page reads carries the code with "The assistant is not available right now." The codes Hercules used for the four cases before (`agent_not_exposed`, `organization_suspended`, `agent_disabled`, `agent_has_no_owner`) are read the same, and stored as `agent_unavailable`, so an app has one code to handle.
- A code the package does not know is handled by its status: a 4xx other than 408 and 429 is final, a 408 or a 5xx is sent again, and a 429 is sent again once `Retry-After` is over, eight times at most. A 429 with a code the package does not know used to be final. `end_user_rate_limited` and `agent_daily_limit_reached` are still final: they are quotas.
- A delete Hercules refuses with any 4xx other than 404, 408, 429 and a 409 `thread_busy` is not asked for again. It used to be asked for a day unless the status was 400, 401 or 403.
- A run whose read Hercules refuses with a 4xx (after the app key was rotated, say) is asked about less and less often, up to every half hour, where it was asked every three minutes. The run stays open for delivery to settle.
- `followRun` connects again after any 5xx, not only 500, 502, 503 and 504.
- The README has a table of what the package does with each answer to a start.

The codes Hercules answered before it reduced its list (`invalid_api_version`, `invalid_authorization`, `unsupported_content`, `credential_required`) are handled as they were: each is a 4xx, and fails the run with Hercules's code and message. A start is taken on a 202 and on a 200 alike. The package never sent `wait_seconds`.
