interface EvaluateRecentAuthParameters {
  authTime: unknown;
  maxAgeSeconds: number;
  nowSeconds: number;
}

/**
 * Evaluate whether an authentication is recent enough, from an `auth_time`
 * claim. Fails closed: a missing/non-numeric `authTime` is reported stale.
 *
 * Shared by the client `useRecentAuth` hook (presentation) and the server
 * `checkRecentAuth` function (enforcement), so both judge recency identically.
 */
export function evaluateRecentAuth({
  authTime,
  maxAgeSeconds,
  nowSeconds,
}: EvaluateRecentAuthParameters) {
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
    return { authenticatedAt: null, isStale: true } as const;
  }

  return {
    authenticatedAt: new Date(authTime * 1000),
    isStale: nowSeconds - authTime > maxAgeSeconds,
  } as const;
}
