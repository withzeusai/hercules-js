import { deleteCookie, getCookies, getRequest, setCookie } from "@tanstack/react-start/server";
import { sessionCookieDomain, sessionCookieMaxAge } from "./config";
import { cookieSecurity, toCookieSameSite } from "./request-url";
import {
  type SessionData,
  chunkValue,
  deserializeSessionCookies,
  sealSession,
  sessionChunkName,
  staleSessionCookieNames,
  unsealSession,
} from "./session";

/**
 * Read and unseal the current request's session, or null when there is no
 * (valid) session cookie. Used by the server functions and actions that run in
 * a TanStack request context.
 */
export async function readSession(): Promise<SessionData | null> {
  const sealed = deserializeSessionCookies(getCookies());
  if (!sealed) return null;
  return unsealSession(sealed);
}

/**
 * Seal `session` and write it across the (chunked) session cookies on the
 * outgoing response, expiring any stale chunks left by a prior session.
 *
 * The cookie's lifetime is the configured session-cookie max age (default ~400
 * days), NOT the access token's: the sealed refresh token must survive the
 * access token so an idle user can be refreshed instead of signed out.
 */
export async function writeSession(session: SessionData): Promise<void> {
  const sealed = await sealSession(session);
  const chunks = chunkValue(sealed);
  // Over HTTPS use SameSite=None; Secure so the session cookie keeps working
  // when the app is embedded cross-site (e.g. read via a server-function fetch
  // from an iframe); fall back to Lax over plain HTTP (local dev).
  const { secure, sameSite } = cookieSecurity(getRequest());
  const sameSiteOption = toCookieSameSite(sameSite);
  const domain = sessionCookieDomain();

  const options = {
    httpOnly: true,
    secure,
    sameSite: sameSiteOption,
    path: "/",
    maxAge: sessionCookieMaxAge(),
    ...(domain ? { domain } : {}),
  };

  chunks.forEach((chunk, index) => setCookie(sessionChunkName(index), chunk, options));

  for (const name of staleSessionCookieNames(Object.keys(getCookies()), chunks.length)) {
    deleteCookie(name, { path: "/", secure, sameSite: sameSiteOption, ...(domain ? { domain } : {}) });
  }
}

/** Expire every session cookie on the outgoing response. */
export function clearSession(): void {
  const { secure, sameSite } = cookieSecurity(getRequest());
  const sameSiteOption = toCookieSameSite(sameSite);
  const domain = sessionCookieDomain();
  for (const name of staleSessionCookieNames(Object.keys(getCookies()), 0)) {
    deleteCookie(name, { path: "/", secure, sameSite: sameSiteOption, ...(domain ? { domain } : {}) });
  }
}
