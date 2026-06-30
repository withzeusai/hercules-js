export function parseCookies(cookieHeader: string): Record<string, string> {
  if (!cookieHeader.trim()) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((cookie) => {
      const [key, ...valueParts] = cookie.trim().split("=");
      return [key, valueParts.join("=")];
    }),
  );
}

/**
 * Parse only the cookie names from a `Cookie` header, skipping the values.
 *
 * Use this when you need the set of cookie names but not their contents — it
 * avoids allocating the (potentially large) value strings that `parseCookies`
 * materializes. Relevant on the PKCE-verifier eviction path, where the header
 * can carry many large encrypted verifier blobs whose values are irrelevant.
 */
export function parseCookieNames(cookieHeader: string): string[] {
  if (!cookieHeader.trim()) return [];
  return cookieHeader
    .split(";")
    .map((cookie) => {
      const eq = cookie.indexOf("=");
      return (eq === -1 ? cookie : cookie.slice(0, eq)).trim();
    })
    .filter(Boolean);
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  maxAge?: number;
}

/**
 * Serialize a cookie name/value pair into a `Set-Cookie` header string.
 *
 * Only the attributes needed by this package are supported. `maxAge` is floored
 * to a whole number of seconds; pass `0` to expire a cookie immediately.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
