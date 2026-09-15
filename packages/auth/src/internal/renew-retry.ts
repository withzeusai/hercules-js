/**
 * Retry policy for a silent renew whose token request timed out.
 *
 * A timeout is the one renew failure where the server may well have succeeded.
 * It rotates the refresh token and revokes the old one before responding, so
 * an aborted request can leave the client holding a token the server has
 * already retired. Replaying that token is treated as reuse, and the server
 * answers reuse by deleting every refresh token for the (client, user) pair --
 * logging the user out on every device.
 *
 * So retries here are bounded and jittered rather than unlimited and
 * lockstep. Previously `maxSilentRenewTimeoutRetries` had no default, which
 * made the guard dead code and the loop infinite at a fixed 5s interval.
 */

/** Retries after a timed-out token request before surfacing the error. */
export const DEFAULT_MAX_TIMEOUT_RETRIES = 3;

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 60_000;

/**
 * Exponential backoff with jitter, for `attempt` counted from 1.
 *
 * The jitter is not incidental: without it every tab that lost the same
 * network blip retries in lockstep, which reproduces the concurrent-replay
 * pattern the bound exists to avoid. Returns a delay in [backoff/2, backoff).
 */
export function renewRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
  return backoff / 2 + Math.random() * (backoff / 2);
}

/** Resolve the retry cap from UserManager settings, falling back to the default. */
export function resolveMaxTimeoutRetries(settings: {
  maxSilentRenewTimeoutRetries?: number;
}): number {
  return settings.maxSilentRenewTimeoutRetries ?? DEFAULT_MAX_TIMEOUT_RETRIES;
}
