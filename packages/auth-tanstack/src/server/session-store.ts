import { deleteCookie, getCookies, getRequest, setCookie } from "@tanstack/react-start/server";
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
 * @param maxAgeSeconds Cookie lifetime; omit for a session-scoped cookie.
 */
export async function writeSession(session: SessionData, maxAgeSeconds?: number): Promise<void> {
  const sealed = await sealSession(session);
  const chunks = chunkValue(sealed);
  const secure = new URL(getRequest().url).protocol === "https:";

  const options = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };

  chunks.forEach((chunk, index) => setCookie(sessionChunkName(index), chunk, options));

  for (const name of staleSessionCookieNames(Object.keys(getCookies()), chunks.length)) {
    deleteCookie(name, { path: "/" });
  }
}

/** Expire every session cookie on the outgoing response. */
export function clearSession(): void {
  for (const name of staleSessionCookieNames(Object.keys(getCookies()), 0)) {
    deleteCookie(name, { path: "/" });
  }
}
