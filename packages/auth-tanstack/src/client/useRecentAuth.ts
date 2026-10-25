import { decodeJwt } from "./jwt";
import { evaluateRecentAuth } from "./recent-auth";
import { tokenSource } from "./tokenStore";
import { useAccessToken } from "./useAccessToken";
import { useIdToken } from "./useIdToken";

/** A token's `auth_time` claim, or undefined when absent or undecodable. */
function authTimeOf(token: string | undefined): unknown {
  if (!token) return undefined;
  try {
    return decodeJwt(token).payload.auth_time;
  } catch {
    return undefined;
  }
}

/**
 * Report how recently the user authenticated, from the `auth_time` claim already
 * in client memory. Presentation only — enforce recency server-side (e.g. by
 * sending the user back through sign-in with `max_age`).
 *
 * `auth_time` is an ID-token claim in OIDC, and many providers leave it off the
 * access token (or issue an opaque one), so the ID token's claim is preferred
 * and the access token's is the fallback — the same precedence
 * `checkRecentAuth` uses on the server, so the two agree.
 */
export function useRecentAuth({ maxAge }: { maxAge: number }) {
  const { idToken, loading: idTokenLoading } = useIdToken();
  const { accessToken, loading: accessTokenLoading } = useAccessToken();

  if (idTokenLoading || accessTokenLoading) {
    return { loading: true, authenticatedAt: undefined, isStale: undefined } as const;
  }

  const fromIdToken = authTimeOf(idToken);
  const recentAuth = evaluateRecentAuth({
    authTime: typeof fromIdToken === "number" ? fromIdToken : authTimeOf(accessToken),
    maxAgeSeconds: maxAge,
    // The server's clock, as measured by the token stores: `auth_time` was
    // stamped by the provider, and the browser's clock may be off.
    nowSeconds: tokenSource.nowSeconds(),
  });

  return { ...recentAuth, loading: false } as const;
}
