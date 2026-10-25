import * as client from "openid-client";
import { clientAuthHint, getConfig } from "./config";
import type { SessionData } from "./session";

/** Longest `Retry-After` (seconds) a rate-limited refresh waits before its retry. */
const MAX_RATE_LIMIT_WAIT_SECONDS = 5;

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

  let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
  try {
    const config = await getConfig();
    tokens = await refreshTokenGrantWithRetry(config, session.refreshToken);
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
