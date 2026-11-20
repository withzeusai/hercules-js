// src/lib/limit-ends-at.ts
import type { AgentThread } from "@usehercules/agents/react";

/** When the limit that failed the thread's latest run is over, or null when no limit did. */
export function limitEndsAt(thread: AgentThread | null | undefined): Date | null {
  const run = thread?.latestRun ?? null;
  if (run === null || run.status !== "failed" || run.finishedAt === null) return null;
  const seconds = run.error?.retryAfterSeconds;
  if (seconds === undefined) return null;
  // `retryAfterSeconds` counts from when the run ended.
  return new Date(Date.parse(run.finishedAt) + seconds * 1000);
}
