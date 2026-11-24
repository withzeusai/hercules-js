import * as client from "openid-client";
import { clientAuthHint, getConfig } from "./config";
import type { SessionData } from "./session";

/** Longest `Retry-After` (seconds) a rate-limited refresh waits before its retry. */
const MAX_RATE_LIMIT_WAIT_SECONDS = 5;

/**
 * How long a finished grant keeps answering requests that still present the
 * refresh token it spent: the browser sends the old cookie until the first
 * response that set the new one has arrived.
 */
const SHARED_GRANT_REUSE_MS = 10_000;

/**
 * How long a request waits on a grant another request started before running
 * its own. On Cloudflare Workers a promise whose I/O belongs to a request that
 * was cancelled (its client went away) never settles.
 */
const SHARED_GRANT_WAIT_MS = 10_000;

type GrantResult = Awaited<ReturnType<typeof client.refreshTokenGrant>>;

interface SharedGrant {
  promise: Promise<GrantResult>;
  /** When the grant succeeded, in epoch ms. Unset while it is in flight. */
  settledAt?: number;
}

/**
 * Refresh grants this isolate ran recently, by the refresh token they spent.
 *
 * A page that sends several requests at once (route preloads, parallel server
 * functions) sends the same expired session cookie with each, and each request
 * resolves its session on its own. Without sharing, every one of them spends a
 * grant: dozens for one page view, which an authorization server rate-limits,
 * and which a server that rotates refresh tokens with reuse detection treats as
 * replay. Keyed by the token itself, so only requests that already hold it can
 * receive what it was exchanged for.
 */
const sharedGrants = new Map<string, SharedGrant>();

/**
 * Exchange `session`'s refresh token for fresh tokens and return the resulting
 * session data. Returns null when there is no refresh token or the grant fails.
 * Pure with respect to cookies — persisting the result is the caller's job
 * (see `session-context.ts`).
 *
 * Providers don't always re-issue an ID token or rotate the refresh token on
 * refresh, so those fall back to the prior session's values.
 */
export async function performRefreshGrant(session: SessionData): Promise<SessionData | null> {
  if (!session.refreshToken) return null;

  let tokens: GrantResult;
  try {
    const config = await getConfig();
    tokens = await sharedRefreshGrant(config, session.refreshToken);
  } catch (error) {
    console.error("[auth-tanstack] Token refresh failed:", error);
    const hint = clientAuthHint(error);
    if (hint) console.error(hint);
    return null;
  }

  const claims = tokens.claims();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? nowSeconds + tokens.expires_in
      : typeof claims?.exp === "number"
        ? claims.exp
        : undefined;

  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token ?? session.idToken,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt,
  };
}

/**
 * The grant for `refreshToken`: one already in flight or just finished in this
 * isolate, or a new one. A failed grant is shared with the requests already
 * waiting on it and then forgotten, so the next request tries again.
 */
function sharedRefreshGrant(
  config: client.Configuration,
  refreshToken: string,
): Promise<GrantResult> {
  const now = Date.now();
  for (const [token, grant] of sharedGrants) {
    if (grant.settledAt !== undefined && now - grant.settledAt > SHARED_GRANT_REUSE_MS) {
      sharedGrants.delete(token);
    }
  }

  const existing = sharedGrants.get(refreshToken);
  if (existing) {
    return existing.settledAt === undefined
      ? waitOrRunOwnGrant(existing.promise, config, refreshToken)
      : existing.promise;
  }

  const grant: SharedGrant = { promise: refreshTokenGrantWithRetry(config, refreshToken) };
  sharedGrants.set(refreshToken, grant);
  grant.promise.then(
    () => {
      grant.settledAt = Date.now();
    },
    () => {
      if (sharedGrants.get(refreshToken) === grant) sharedGrants.delete(refreshToken);
    },
  );
  return grant.promise;
}

/** Wait on another request's grant, or run this request's own if it takes too long. */
async function waitOrRunOwnGrant(
  shared: Promise<GrantResult>,
  config: client.Configuration,
  refreshToken: string,
): Promise<GrantResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, SHARED_GRANT_WAIT_MS, undefined);
  });
  try {
    const result = await Promise.race([shared, timedOut]);
    return result ?? (await refreshTokenGrantWithRetry(config, refreshToken));
  } finally {
    clearTimeout(timer);
  }
}

/** Test helper: forget every shared grant. */
export function clearSharedRefreshGrants(): void {
  sharedGrants.clear();
}

/**
 * Run the refresh grant, retrying once when the provider rate-limits it. A 429
 * means the request was refused without being processed, so the refresh token
 * is still unspent and a retry is safe even when the provider rotates refresh
 * tokens. Other failures are not retried: a provider that failed after
 * rotating would treat a second use of the token as reuse.
 */
async function refreshTokenGrantWithRetry(
  config: client.Configuration,
  refreshToken: string,
): ReturnType<typeof client.refreshTokenGrant> {
  try {
    return await client.refreshTokenGrant(config, refreshToken);
  } catch (error) {
    const response = rateLimitedResponse(error);
    if (!response) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds(response) * 1000));
    return client.refreshTokenGrant(config, refreshToken);
  }
}

/**
 * The 429 response behind a failed grant, if that is what it was. openid-client
 * puts the response on `response` when the body is an OAuth error, and on
 * `cause` when it is not.
 */
function rateLimitedResponse(error: unknown): Response | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = "response" in error ? error.response : error.cause;
  return candidate instanceof Response && candidate.status === 429 ? candidate : undefined;
}

/** Seconds to wait before retrying, from `Retry-After` (seconds or an HTTP date), capped. */
function retryAfterSeconds(response: Response): number {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return 1;
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.max(1, seconds), MAX_RATE_LIMIT_WAIT_SECONDS)
    : 1;
}

/**
 * Resolve where to send a user signing out: the provider's `end_session_endpoint`
 * (with `id_token_hint` when available), or `postLogoutRedirectUri` when the
 * provider advertises no end-session endpoint or discovery fails.
 */
export async function resolveLogoutLocation(
  postLogoutRedirectUri: string,
  idTokenHint?: string,
): Promise<string> {
  try {
    const config = await getConfig();
    if (config.serverMetadata().end_session_endpoint) {
      const parameters: Record<string, string> = {
        post_logout_redirect_uri: postLogoutRedirectUri,
      };
      if (idTokenHint) parameters.id_token_hint = idTokenHint;
      return client.buildEndSessionUrl(config, parameters).toString();
    }
  } catch (error) {
    // Discovery/metadata failure shouldn't trap the user in a session — log and
    // fall back to a local redirect (the cookie is cleared regardless).
    console.error("[auth-tanstack] Failed to build end-session URL:", error);
  }
  return postLogoutRedirectUri;
}
