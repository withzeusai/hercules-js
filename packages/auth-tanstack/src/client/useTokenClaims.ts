import { useMemo } from "react";
import { decodeJwt, type TokenClaims } from "./jwt";
import { useAccessToken } from "./useAccessToken";

/**
 * Decode the claims of the current access token.
 *
 * @example
 * ```ts
 * const { org_id, role } = useTokenClaims();
 * const { plan } = useTokenClaims<{ plan: string }>();
 * ```
 * @returns The token claims, or an empty object when no token is available.
 */
export function useTokenClaims<T = Record<string, unknown>>(): TokenClaims<T> {
  const { accessToken } = useAccessToken();

  return useMemo(() => {
    if (!accessToken) return {};
    try {
      return decodeJwt<T>(accessToken).payload;
    } catch {
      return {};
    }
  }, [accessToken]);
}
