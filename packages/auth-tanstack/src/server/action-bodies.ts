import { getRequest } from "@tanstack/react-start/server";
import type { ClientUserInfo, NoUserInfo, UserInfo } from "../types";
import { userInfoFromSession } from "./claims";
import { resolveLogoutLocation } from "./refresh";
import { resolvePostLogoutRedirectUri } from "./request-url";
import type { SessionData } from "./session";
import { getResolvedSession, refreshResolvedSession } from "./session-context";
import { clearSession, readSession } from "./session-store";

/** Strip the access token from a {@link UserInfo} before sending it to a client. */
function toClientUserInfo(info: UserInfo | NoUserInfo): ClientUserInfo | NoUserInfo {
  if (!info.user) return { user: null };
  const { accessToken: _accessToken, ...rest } = info;
  return rest;
}

/** Backs `getAuthAction`: sanitized auth state (no access token). */
export async function getAuthBody(): Promise<ClientUserInfo | NoUserInfo> {
  const session = await getResolvedSession();
  if (!session) return { user: null };
  return toClientUserInfo(userInfoFromSession(session));
}

/** Backs `checkSessionAction`: whether a valid session is present. */
export async function checkSessionBody(): Promise<boolean> {
  const session = await getResolvedSession();
  if (!session) return false;
  return userInfoFromSession(session).user !== null;
}

/** Backs `getAccessTokenAction`: the current access token, if authenticated. */
export async function getAccessTokenBody(): Promise<string | undefined> {
  const session = await getResolvedSession();
  if (!session) return undefined;
  return userInfoFromSession(session).user ? session.accessToken : undefined;
}

/**
 * The session a refresh action should report: the refreshed session when a
 * refresh grant ran, otherwise the current session if it is still valid.
 *
 * A refresh is impossible without a refresh token (the provider issues none
 * unless `offline_access` was granted) and can fail transiently. Neither means
 * the user is signed out — the current access/ID token may have hours left —
 * yet callers treat an empty refresh result as exactly that. Convex is the
 * concrete casualty: `ConvexProviderWithAuth` re-requests the token with
 * `forceRefreshToken: true` right after confirming the cached one, and an empty
 * answer there drops the client to "unauthenticated" for the rest of the page.
 * So "refresh" means "the freshest tokens available", never "nothing".
 */
async function refreshedOrCurrentSession(): Promise<SessionData | null> {
  const refreshed = await refreshResolvedSession();
  if (refreshed) return refreshed;
  const current = await getResolvedSession();
  if (!current || !userInfoFromSession(current).user) return null;
  return current;
}

/**
 * Backs `refreshAccessTokenAction`: refresh and return the new access token, or
 * the current one when no refresh is possible and it is still valid.
 */
export async function refreshAccessTokenBody(): Promise<string | undefined> {
  const session = await refreshedOrCurrentSession();
  return session?.accessToken;
}

/**
 * Backs `getIdTokenAction`: the current ID token, if authenticated. Undefined
 * when the provider issued no ID token (the `openid` scope was not granted).
 */
export async function getIdTokenBody(): Promise<string | undefined> {
  const session = await getResolvedSession();
  if (!session) return undefined;
  return userInfoFromSession(session).user ? session.idToken : undefined;
}

/**
 * Backs `refreshIdTokenAction`: refresh and return the new ID token, or the
 * current one when no refresh is possible and the session is still valid.
 */
export async function refreshIdTokenBody(): Promise<string | undefined> {
  const session = await refreshedOrCurrentSession();
  return session?.idToken;
}

/**
 * Backs `refreshAuthAction`: refresh and return sanitized auth state. Falls back
 * to the current session's state when no refresh is possible, so a provider
 * that issued no refresh token does not sign the user out client-side.
 */
export async function refreshAuthBody(): Promise<ClientUserInfo | NoUserInfo> {
  const session = await refreshedOrCurrentSession();
  if (!session) return { user: null };
  return toClientUserInfo(userInfoFromSession(session));
}

/**
 * Backs `getSignOutUrl`: clear the session and return where the client should
 * navigate to complete sign-out (the provider's end-session URL, or `returnTo`).
 *
 * Reads the raw session (no auto-refresh) — refreshing tokens just to discard
 * them would be a wasted grant.
 *
 * With no session there is nothing for the provider to end, and an end-session
 * request carrying no `id_token_hint` makes the OP interrupt with its own
 * confirmation page — so a user whose session already lapsed would be asked to
 * confirm signing out of nothing. Go straight to the post-logout target
 * instead, as WorkOS's AuthKit does.
 */
export async function getSignOutUrlBody(returnTo?: string): Promise<{ url: string }> {
  const session = await readSession();
  const postLogoutRedirectUri = resolvePostLogoutRedirectUri(getRequest(), returnTo);
  const url = session
    ? await resolveLogoutLocation(postLogoutRedirectUri, session.idToken)
    : postLogoutRedirectUri;

  // Clear the session on this response so the cookie is gone before the client
  // navigates away to complete sign-out.
  clearSession();

  return { url };
}
