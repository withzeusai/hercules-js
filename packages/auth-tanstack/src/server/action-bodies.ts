import { getRequest } from "@tanstack/react-start/server";
import type { ClientUserInfo, NoUserInfo, UserInfo } from "../types";
import { userInfoFromSession } from "./claims";
import { DEFAULT_REDIRECT } from "./config";
import { refreshSession, resolveLogoutLocation } from "./refresh";
import { clearSession, readSession } from "./session-store";

/** Strip the access token from a {@link UserInfo} before sending it to a client. */
function toClientUserInfo(info: UserInfo | NoUserInfo): ClientUserInfo | NoUserInfo {
  if (!info.user) return { user: null };
  const { accessToken: _accessToken, ...rest } = info;
  return rest;
}

/** Backs `getAuthAction`: sanitized auth state (no access token). */
export async function getAuthBody(): Promise<ClientUserInfo | NoUserInfo> {
  const session = await readSession();
  if (!session) return { user: null };
  return toClientUserInfo(userInfoFromSession(session));
}

/** Backs `checkSessionAction`: whether a valid session is present. */
export async function checkSessionBody(): Promise<boolean> {
  const session = await readSession();
  if (!session) return false;
  return userInfoFromSession(session).user !== null;
}

/** Backs `getAccessTokenAction`: the current access token, if authenticated. */
export async function getAccessTokenBody(): Promise<string | undefined> {
  const session = await readSession();
  if (!session) return undefined;
  return userInfoFromSession(session).user ? session.accessToken : undefined;
}

/** Backs `refreshAccessTokenAction`: refresh and return the new access token. */
export async function refreshAccessTokenBody(): Promise<string | undefined> {
  const session = await refreshSession();
  return session?.accessToken;
}

/**
 * Backs `getIdTokenAction`: the current ID token, if authenticated. Undefined
 * when the provider issued no ID token (the `openid` scope was not granted).
 */
export async function getIdTokenBody(): Promise<string | undefined> {
  const session = await readSession();
  if (!session) return undefined;
  return userInfoFromSession(session).user ? session.idToken : undefined;
}

/** Backs `refreshIdTokenAction`: refresh and return the new ID token. */
export async function refreshIdTokenBody(): Promise<string | undefined> {
  const session = await refreshSession();
  return session?.idToken;
}

/** Backs `refreshAuthAction`: refresh and return sanitized auth state. */
export async function refreshAuthBody(): Promise<ClientUserInfo | NoUserInfo> {
  const session = await refreshSession();
  if (!session) return { user: null };
  return toClientUserInfo(userInfoFromSession(session));
}

/**
 * Backs `getSignOutUrl`: clear the session and return where the client should
 * navigate to complete sign-out (the provider's end-session URL, or `returnTo`).
 */
export async function getSignOutUrlBody(returnTo?: string): Promise<{ url: string }> {
  const idTokenHint = (await readSession())?.idToken;
  const origin = new URL(getRequest().url).origin;
  const postLogoutRedirectUri = new URL(returnTo ?? DEFAULT_REDIRECT, origin).toString();
  const url = await resolveLogoutLocation(postLogoutRedirectUri, idTokenHint);

  // Clear the session on this response so the cookie is gone before the client
  // navigates away to complete sign-out.
  clearSession();

  return { url };
}
