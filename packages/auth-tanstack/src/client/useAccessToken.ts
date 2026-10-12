import { tokenStore } from "./tokenStore";
import type { UseAccessTokenReturn } from "./types";
import { useManagedToken } from "./useManagedToken";

/**
 * Manage the access token with automatic, proactive refresh. Fetches on mount
 * (and when the session/user changes), refreshes ahead of expiry, and refreshes
 * again when the tab wakes (focus/visibility/online/pageshow).
 */
export function useAccessToken(): UseAccessTokenReturn {
  const { token, loading, error, refresh, getToken } = useManagedToken(tokenStore);
  return { accessToken: token, loading, error, refresh, getAccessToken: getToken };
}
