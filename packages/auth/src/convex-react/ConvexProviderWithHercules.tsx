"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { jwtDecode } from "jwt-decode";
import { useCallback, useMemo, useRef } from "react";
import { useAuth } from "react-oidc-context";
import { withRefreshLock } from "../internal/refresh-lock";
import type { HerculesAuthProvider } from "../react/HerculesAuthProvider";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function tokenExpiresWithin(token: string, ms: number): boolean {
  try {
    const payload = jwtDecode(token);
    return payload.exp! * 1000 - Date.now() < ms;
  } catch {
    return true;
  }
}

function useUseAuthFromHercules() {
  const { isAuthenticated, user, isLoading, signinSilent } = useAuth();
  const idToken = user?.id_token;
  const issuer = user?.profile?.iss;
  const subject = user?.profile?.sub;

  const idTokenRef = useRef(idToken);
  idTokenRef.current = idToken;

  const signinSilentRef = useRef(signinSilent);
  signinSilentRef.current = signinSilent;

  const inFlightRefresh = useRef<Promise<string | null> | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const currentToken = idTokenRef.current;
      if (!forceRefreshToken) {
        return currentToken ?? null;
      }
      if (
        currentToken != null &&
        !tokenExpiresWithin(currentToken, REFRESH_THRESHOLD_MS)
      ) {
        return currentToken;
      }
      if (inFlightRefresh.current) {
        return inFlightRefresh.current;
      }
      const refresh = withRefreshLock(async () => {
        const tokenAfterLock = idTokenRef.current;
        if (
          tokenAfterLock != null &&
          !tokenExpiresWithin(tokenAfterLock, REFRESH_THRESHOLD_MS)
        ) {
          return tokenAfterLock;
        }
        try {
          const refreshed = await signinSilentRef.current();
          return refreshed?.id_token ?? null;
        } catch {
          return null;
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

/**
 * A wrapper React component which provides a {@link ConvexReactClient}
 * authenticated with Hercules Auth.
 *
 * It must be wrapped by a configured `{@link HerculesAuthProvider}`.
 *
 * @public
 */
export function ConvexProviderWithHerculesAuth({
  children,
  client,
}: {
  children: ReactNode;
  client: ConvexReactClient;
}) {
  return (
    <ConvexProviderWithAuth client={client} useAuth={useUseAuthFromHercules}>
      {children}
    </ConvexProviderWithAuth>
  );
}
