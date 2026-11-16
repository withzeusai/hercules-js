/** Errors the browser entry points hand to the page. No React or Convex imports. */

/** A run that failed, or a message that could not be sent. */
export class AgentError extends Error {
  readonly code: string;
  /**
   * How long until it may work again, when a limit is why it failed
   * (`end_user_rate_limited`, `agent_daily_limit_reached`): from when the
   * message was refused, or for a run, from when it ended.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The error to show for one a Convex call threw. A `ConvexError` from the
 * app's agent functions carries `{ code, message, retryAfterSeconds? }`, and
 * becomes an `AgentError` with that code.
 */
export function toAgentError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (typeof data === "object" && data !== null && "code" in data && "message" in data) {
      const { code, message } = data as { code: unknown; message: unknown };
      const retryAfter = (data as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof code === "string" && typeof message === "string") {
        return new AgentError(
          code,
          message,
          typeof retryAfter === "number" ? retryAfter : undefined,
        );
      }
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
