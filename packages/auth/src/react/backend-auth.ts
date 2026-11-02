"use client";

import { jwtDecode } from "jwt-decode";
import { ErrorResponse } from "oidc-client-ts";
import { useCallback, useContext, useMemo, useRef } from "react";
import { useAuth } from "react-oidc-context";
import { HerculesAuthProviderContext } from "../internal/auth-context";
import { withRefreshLock } from "../internal/refresh-lock";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const RETRY_DELAYS_MS = [1_000, 3_000];
const OFFLINE_WAIT_MS = 30_000;

// A backend reads a null token as signed out (Convex then never asks again), so only
// the server's verdict (an OAuth error or other 4xx) may end the session. A dropped
// connection, timeout, or 5xx is retried.
function isTransientRefreshError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (err instanceof ErrorResponse) {
    return err.error === "server_error" || err.error === "temporarily_unavailable";
  }
  if (!(err instanceof Error)) return false;
  return err instanceof TypeError || err.name === "ErrorTimeout" || /\(5\d\d\)/.test(err.message);
}

// Waits out the backoff, or while offline until the browser reports `online`.
function waitBeforeRetry(ms: number): Promise<void> {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, offline ? OFFLINE_WAIT_MS : ms);
    if (offline) window.addEventListener("online", done);
  });
}

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
 * `ConvexProviderWithAuth` and Fundulus's `FundulusProviderWithAuth` take, as
 * `useAuth`. It must be called inside a configured `HerculesAuthProvider`.
 *
 * `fetchAccessToken` hands back the current ID token, and with `forceRefreshToken`
 * refreshes it silently once it's within an hour of expiring: one refresh at a time,
 * across tabs where the browser has Web Locks, retried twice if it fails for a
 * transient reason. It keeps its identity while the user does.
 *
 * @example
 * <FundulusProviderWithAuth client={client} useAuth={useBackendAuth}>
 *   <App />
 * </FundulusProviderWithAuth>
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
        const manager = userManagerRef.current;
        for (let attempt = 0; ; attempt++) {
          try {
            const refreshed = await (manager ? manager.signinSilent() : signinSilentRef.current());
            return refreshed?.id_token ?? null;
          } catch (err) {
            const delay = RETRY_DELAYS_MS[attempt];
            if (delay !== undefined && isTransientRefreshError(err)) {
              await waitBeforeRetry(delay);
              continue;
            }
            // Record the failure in auth state, as react-oidc-context's wrapper does.
            void manager?.events._raiseSilentRenewError(err as Error);
            return null;
          }
        }
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
