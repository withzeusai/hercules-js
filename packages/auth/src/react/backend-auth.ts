"use client";

import { jwtDecode } from "jwt-decode";
import { useCallback, useContext, useMemo, useRef } from "react";
import { useAuth } from "react-oidc-context";
import { HerculesAuthProviderContext } from "../internal/auth-context";
import { withRefreshLock } from "../internal/refresh-lock";
import { renewWithRetry } from "../internal/renew";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
function tokenExpiresWithin(token: string, ms: number): boolean {
  try {
    const payload = jwtDecode(token);
    return payload.exp! * 1000 - Date.now() < ms;
  } catch {
    return true;
  }
}

/**
 * The signed-in user's ID token, for a backend's auth provider: the hook Convex's
 * `ConvexProviderWithAuth` and Olympus's `OlympusProviderWithAuth` take, as
 * `useAuth`. It must be called inside a configured `HerculesAuthProvider`.
 *
 * `fetchAccessToken` hands back the current ID token, and with `forceRefreshToken`
 * refreshes it silently once it's within an hour of expiring: one refresh at a time,
 * across tabs where the browser has Web Locks, retried twice if it fails for a
 * transient reason. It keeps its identity while the user does.
 *
 * @example
 * <OlympusProviderWithAuth client={client} useAuth={useBackendAuth}>
 *   <App />
 * </OlympusProviderWithAuth>
 *
 * @public
 */
export function useBackendAuth() {
  const { isAuthenticated, user, isLoading, signinSilent } = useAuth();
  const idToken = user?.id_token;
  const issuer = user?.profile?.iss;
  const subject = user?.profile?.sub;

  const idTokenRef = useRef(idToken);
  idTokenRef.current = idToken;

  const signinSilentRef = useRef(signinSilent);
  signinSilentRef.current = signinSilent;

  // react-oidc-context's signinSilent resolves null on failure, hiding the
  // error, so call the manager directly when HerculesAuthProvider supplies it.
  const userManager = useContext(HerculesAuthProviderContext)?.userManager;
  const userManagerRef = useRef(userManager);
  userManagerRef.current = userManager;

  const inFlightRefresh = useRef<Promise<string | null> | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const currentToken = idTokenRef.current;
      if (!forceRefreshToken) {
        return currentToken ?? null;
      }
      if (currentToken != null && !tokenExpiresWithin(currentToken, REFRESH_THRESHOLD_MS)) {
        return currentToken;
      }
      if (inFlightRefresh.current) {
        return inFlightRefresh.current;
      }
      const refresh = withRefreshLock(async () => {
        const tokenAfterLock = idTokenRef.current;
        if (tokenAfterLock != null && !tokenExpiresWithin(tokenAfterLock, REFRESH_THRESHOLD_MS)) {
          return tokenAfterLock;
        }
        // A backend reads a null token as signed out (Convex then never asks again),
        // so a transient failure is retried before it gives up.
        const manager = userManagerRef.current;
        const refreshed = await renewWithRetry(
          () => (manager ? manager.signinSilent() : signinSilentRef.current()),
          manager,
        );
        return refreshed?.id_token ?? null;
      }).finally(() => {
        inFlightRefresh.current = null;
      });
      inFlightRefresh.current = refresh;
      return refresh;
    },
    [issuer, subject],
  );

  return useMemo(
    () => ({
      isLoading: isAuthenticated ? false : isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}
