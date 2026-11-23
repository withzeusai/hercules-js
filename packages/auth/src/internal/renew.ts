import { ErrorResponse, type User, type UserManager } from "oidc-client-ts";

const RETRY_DELAYS_MS = [1_000, 3_000];
const OFFLINE_WAIT_MS = 30_000;

// Only the server's verdict (an OAuth error or other 4xx) may end the session. A
// dropped connection, timeout, or 5xx is retried.
function isTransientRefreshError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (err instanceof ErrorResponse) {
    return err.error === "server_error" || err.error === "temporarily_unavailable";
  }
  if (!(err instanceof Error)) return false;
  return err instanceof TypeError || err.name === "ErrorTimeout" || /\(5\d\d\)/.test(err.message);
}

// Waits out the backoff, or while offline until the browser reports `online`.
function waitBeforeRetry(ms: number): Promise<void> {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, offline ? OFFLINE_WAIT_MS : ms);
    if (offline) window.addEventListener("online", done);
  });
}

/**
 * Runs `renew`, retrying twice when it fails for a transient reason. A final
 * failure resolves null and is recorded in auth state, as react-oidc-context's
 * wrapper does.
 */
export async function renewWithRetry(
  renew: () => Promise<User | null>,
  manager?: UserManager,
): Promise<User | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renew();
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined && isTransientRefreshError(err)) {
        await waitBeforeRetry(delay);
        continue;
      }
      void manager?.events._raiseSilentRenewError(err as Error);
      return null;
    }
  }
}
