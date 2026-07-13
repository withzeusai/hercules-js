import * as client from "openid-client";
import { getConfig } from "./config";
import type { SessionData } from "./session";

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
    tokens = await client.refreshTokenGrant(config, session.refreshToken);
  } catch (error) {
    console.error("[auth-tanstack] Token refresh failed:", error);
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
