import { idTokenStore } from "./tokenStore";
import type { UseIdTokenReturn } from "./types";
import { useManagedToken } from "./useManagedToken";

/**
 * Manage the OIDC ID token with automatic, proactive refresh — the same fetch/
 * refresh lifecycle as {@link useAccessToken}, but for the `id_token`. `idToken`
 * is undefined when the provider issued none (the `openid` scope was not
 * granted).
 */
export function useIdToken(): UseIdTokenReturn {
  const { token, loading, error, refresh, getToken } = useManagedToken(idTokenStore);
  return { idToken: token, loading, error, refresh, getIdToken: getToken };
}
