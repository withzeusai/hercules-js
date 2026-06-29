import { evaluateRecentAuth } from "./recent-auth";
import { useAccessToken } from "./useAccessToken";
import { useTokenClaims } from "./useTokenClaims";

/**
 * Report how recently the user authenticated, from the `auth_time` claim already
 * in client memory. Presentation only — enforce recency server-side (e.g. by
 * sending the user back through sign-in with `max_age`).
 */
export function useRecentAuth({ maxAge }: { maxAge: number }) {
  const { loading } = useAccessToken();
  const { auth_time } = useTokenClaims();

  if (loading) {
    return { loading: true, authenticatedAt: undefined, isStale: undefined } as const;
  }

  const recentAuth = evaluateRecentAuth({
    authTime: auth_time,
    maxAgeSeconds: maxAge,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  return { ...recentAuth, loading } as const;
}
