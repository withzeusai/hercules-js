// src/lib/watch-run.ts
import { followRun, RunStreamError, type AgentEvent } from "@usehercules/agents";

/** One line to show for an event, or null for one this page says nothing of. */
function lineFor(event: AgentEvent): string | null {
  switch (event.type) {
    case "run.progress":
      return event.data.label;
    case "tool_call.completed":
      return event.data.summary;
    case "run.failed":
      return `Failed: ${event.data.error.code}`;
    case "run.capped":
      return `Stopped at a limit: ${event.data.capped_reason ?? "not named"}`;
    default:
      // The types this page does not show, and any type added later. Check
      // `final`, not the type: an ending of a type added later still ends the run.
      return event.final ? `Ended: ${String(event.type)}` : null;
  }
}

export async function watchRun(
  live: { url: string; token: string },
  show: (line: string) => void,
  signal?: AbortSignal,
) {
  try {
    for await (const event of followRun({ url: live.url, token: live.token, signal })) {
      const line = lineFor(event);
      if (line !== null) show(line);
    }
  } catch (error) {
    // The live view failed, not the run: the reply still reaches the app's thread.
    if (!(error instanceof RunStreamError)) throw error;
  }
}
