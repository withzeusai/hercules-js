import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "./HerculesAuthProvider";
import { tokenStore } from "./tokenStore";
import type { UseAccessTokenReturn } from "./types";

/**
 * Manage the access token with automatic, proactive refresh. Fetches on mount
 * (and when the session/user changes), refreshes ahead of expiry, and refreshes
 * again when the tab wakes (focus/visibility/online/pageshow).
 */
export function useAccessToken(): UseAccessTokenReturn {
  const { user, sessionId } = useAuth();
  const userId = user?.id;
  const userRef = useRef(user);
  userRef.current = user;
  const prevSessionRef = useRef(sessionId);
  const prevUserIdRef = useRef(userId);

  const tokenState = useSyncExternalStore(tokenStore.subscribe, tokenStore.getSnapshot, tokenStore.getServerSnapshot);

  const [isInitialTokenLoading, setIsInitialTokenLoading] = useState(
    () => Boolean(user && !tokenState.token && !tokenState.error),
  );

  useEffect(() => {
    if (!user) {
      setIsInitialTokenLoading(false);
      if (prevUserIdRef.current !== undefined) tokenStore.clearToken();
      prevUserIdRef.current = undefined;
      prevSessionRef.current = undefined;
      return;
    }

    const sessionChanged = prevSessionRef.current !== undefined && prevSessionRef.current !== sessionId;
    const userChanged = prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId;
    if (sessionChanged || userChanged) tokenStore.clearToken();

    prevSessionRef.current = sessionId;
    prevUserIdRef.current = userId;

    const currentToken = tokenStore.getSnapshot().token;
    const tokenData = currentToken ? tokenStore.parseToken(currentToken) : null;
    const willFetch = !currentToken || (tokenData?.isExpiring ?? false);
    if (willFetch) setIsInitialTokenLoading(true);

    tokenStore
      .getAccessTokenSilently()
      .catch(() => {})
      .finally(() => {
        if (willFetch) setIsInitialTokenLoading(false);
      });
  }, [userId, sessionId, user]);

  useEffect(() => {
    if (!user || typeof document === "undefined") return;

    const refreshIfNeeded = () => {
      void tokenStore.getAccessTokenSilently().catch(() => {});
    };
    const handleWake = (event: Event) => {
      if (event.type !== "visibilitychange" || document.visibilityState === "visible") {
        refreshIfNeeded();
      }
    };

    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("focus", handleWake);
    window.addEventListener("online", handleWake);
    window.addEventListener("pageshow", handleWake);
    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("focus", handleWake);
      window.removeEventListener("online", handleWake);
      window.removeEventListener("pageshow", handleWake);
    };
  }, [userId, sessionId, user]);

  const getAccessToken = useCallback(async (): Promise<string | undefined> => {
    return userRef.current ? tokenStore.getAccessToken() : undefined;
  }, []);

  const refresh = useCallback(async (): Promise<string | undefined> => {
    return userRef.current ? tokenStore.refreshToken() : undefined;
  }, []);

  return {
    accessToken: tokenState.token,
    loading: isInitialTokenLoading || tokenState.loading,
    error: tokenState.error,
    refresh,
    getAccessToken,
  };
}
