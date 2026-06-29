import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "./HerculesAuthProvider";
import type { TokenStore } from "./tokenStore";

/** Reactive state and actions for a single managed token. */
export interface ManagedToken {
  /** Current token. May be briefly stale; use {@link ManagedToken.getToken} when freshness matters. */
  token: string | undefined;
  /** Whether a token fetch/refresh is in flight. */
  loading: boolean;
  /** The last token error, or null. */
  error: Error | null;
  /** Force a refresh, returning the new token. */
  refresh: () => Promise<string | undefined>;
  /** Get a guaranteed-fresh token, refreshing if needed. */
  getToken: () => Promise<string | undefined>;
}

/**
 * Drive a {@link TokenStore} from React: fetch on mount (and when the
 * session/user changes), refresh ahead of expiry, and refresh again when the tab
 * wakes (focus/visibility/online/pageshow). Backs {@link useAccessToken} and
 * {@link useIdToken}; `store` is a stable module singleton.
 */
export function useManagedToken(store: TokenStore): ManagedToken {
  const { user, sessionId } = useAuth();
  const userId = user?.id;
  const userRef = useRef(user);
  userRef.current = user;
  const prevSessionRef = useRef(sessionId);
  const prevUserIdRef = useRef(userId);

  const tokenState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  const [isInitialTokenLoading, setIsInitialTokenLoading] = useState(
    () => Boolean(user && !tokenState.token && !tokenState.error),
  );

  useEffect(() => {
    if (!user) {
      setIsInitialTokenLoading(false);
      if (prevUserIdRef.current !== undefined) store.clearToken();
      prevUserIdRef.current = undefined;
      prevSessionRef.current = undefined;
      return;
    }

    const sessionChanged = prevSessionRef.current !== undefined && prevSessionRef.current !== sessionId;
    const userChanged = prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId;
    if (sessionChanged || userChanged) store.clearToken();

    prevSessionRef.current = sessionId;
    prevUserIdRef.current = userId;

    const currentToken = store.getSnapshot().token;
    const tokenData = currentToken ? store.parseToken(currentToken) : null;
    const willFetch = !currentToken || (tokenData?.isExpiring ?? false);
    if (willFetch) setIsInitialTokenLoading(true);

    store
      .getTokenSilently()
      .catch(() => {})
      .finally(() => {
        if (willFetch) setIsInitialTokenLoading(false);
      });
  }, [userId, sessionId, user, store]);

  useEffect(() => {
    if (!user || typeof document === "undefined") return;

    const refreshIfNeeded = () => {
      void store.getTokenSilently().catch(() => {});
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
  }, [userId, sessionId, user, store]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    return userRef.current ? store.getToken() : undefined;
  }, [store]);

  const refresh = useCallback(async (): Promise<string | undefined> => {
    return userRef.current ? store.refreshToken() : undefined;
  }, [store]);

  return {
    token: tokenState.token,
    loading: isInitialTokenLoading || tokenState.loading,
    error: tokenState.error,
    refresh,
    getToken,
  };
}
