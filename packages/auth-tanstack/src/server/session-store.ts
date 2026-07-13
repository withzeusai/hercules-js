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

  const existingNames = Object.keys(getCookies());
  for (const name of staleSessionCookieNames(existingNames, chunks.length)) {
    expireCookie(name, { secure, sameSite: sameSiteOption, domain });
  }

  // When writing domain-scoped chunks, also expire host-only cookies carrying
  // the just-written names (left from before the domain was configured) —
  // browsers send the older host-only cookie first and it would shadow the
  // fresh session on reads. Distinct from the domain-scoped set above in h3's
  // Set-Cookie dedup (name+domain+path), so both headers survive.
  if (domain) {
    for (let index = 0; index < chunks.length; index++) {
      const name = sessionChunkName(index);
      if (existingNames.includes(name)) {
        deleteCookie(name, { path: "/", secure, sameSite: sameSiteOption });
      }
    }
  }
}

/** Expire every session cookie on the outgoing response. */
export function clearSession(): void {
  const { secure, sameSite } = cookieSecurity(getRequest());
  const sameSiteOption = toCookieSameSite(sameSite);
  const domain = sessionCookieDomain();
  for (const name of staleSessionCookieNames(Object.keys(getCookies()), 0)) {
    expireCookie(name, { secure, sameSite: sameSiteOption, domain });
  }
}

/**
 * Delete one session cookie. When a domain is configured the cookie is deleted
 * both domain-scoped and host-only: deletion matches on name/path/domain, so a
 * host-only cookie set before the domain was configured needs its own delete.
 * (h3 keys Set-Cookie dedup on name+domain+path, so both deletes survive.)
 */
function expireCookie(
  name: string,
  options: {
    secure: boolean;
    sameSite: ReturnType<typeof toCookieSameSite>;
    domain: string | undefined;
  },
): void {
  const { secure, sameSite, domain } = options;
  if (domain) deleteCookie(name, { path: "/", secure, sameSite, domain });
  deleteCookie(name, { path: "/", secure, sameSite });
}
