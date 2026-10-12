import { getRequest } from "@tanstack/react-start/server";
import { performRefreshGrant } from "./refresh";
import { type SessionData, isSessionExpired } from "./session";
import { readSession, writeSession } from "./session-store";

// Per-request session resolution. Keyed on the Request object so that within
// one request (an SSR pass running several loaders, or one server function) the
// cookie is unsealed — and an expired session refreshed — exactly once, and so
// a refresh that rotates the refresh token is seen by every later reader in the
// same request instead of each re-reading the now-stale request cookie.
//
// The promise (not the value) is cached, so concurrent readers share a single
// in-flight resolution rather than racing duplicate refresh grants.
interface ResolvedSession {
  session: SessionData | null;
  /**
   * Whether resolving performed a (successful) transparent refresh grant. A
   * user-initiated refresh then returns this fresh session instead of running
   * a second back-to-back grant — which would waste, and under strict rotation
   * could invalidate, the just-issued refresh token.
   */
  autoRefreshed: boolean;
}

const resolved = new WeakMap<Request, Promise<ResolvedSession>>();

function getResolved(): Promise<ResolvedSession> {
  const request = getRequest();
  let promise = resolved.get(request);
  if (!promise) {
    promise = resolveSession();
    resolved.set(request, promise);
  }
  return promise;
}

/**
 * The current request's session, unsealed once and auto-refreshed when the
 * access token has expired and a refresh token is available. A successful
 * refresh re-seals the session onto the outgoing response, so an idle user is
 * transparently signed back in on their next request instead of appearing
 * signed out until the client gets around to refreshing.
 *
 * Returns the stale session when refresh is impossible or fails (the claims
 * mapping resolves it to `{ user: null }`); a failed refresh is not fatal here
 * so a transient provider outage doesn't sign users out.
 */
export async function getResolvedSession(): Promise<SessionData | null> {
  return (await getResolved()).session;
}

async function resolveSession(): Promise<ResolvedSession> {
  const session = await readSession();
  if (!session) return { session: null, autoRefreshed: false };
  if (!isSessionExpired(session) || !session.refreshToken) {
    return { session, autoRefreshed: false };
  }

  const next = await performRefreshGrant(session);
  if (!next) return { session, autoRefreshed: false };

  await writeSession(next);
  return { session: next, autoRefreshed: true };
}

/**
 * Force a refresh of the current request's session (user-initiated refresh),
 * re-seal it onto the response, and update the per-request cache so later
 * readers — including a second refresh — see the rotated tokens. When resolving
 * the session already refreshed it (expired access token), that fresh session
 * is returned as-is rather than immediately spending a second grant. Returns
 * null when there is no session/refresh token or the grant fails.
 */
export async function refreshResolvedSession(): Promise<SessionData | null> {
  const request = getRequest();
  const { session, autoRefreshed } = await getResolved();
  if (autoRefreshed && session) return session;
  if (!session?.refreshToken) return null;

  const next = await performRefreshGrant(session);
  if (!next) return null;

  await writeSession(next);
  resolved.set(request, Promise.resolve({ session: next, autoRefreshed: false }));
  return next;
}
