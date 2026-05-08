"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { useCallback, useMemo, useRef } from "react";
import { useAuth } from "react-oidc-context";
import type { HerculesAuthProvider } from "../react/HerculesAuthProvider";

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

function useUseAuthFromHercules() {
  const { isAuthenticated, user, isLoading, signinSilent } = useAuth();
  const idToken = user?.id_token;

  const inFlightRefresh = useRef<Promise<string | null> | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (!forceRefreshToken) {
        return idToken ?? null;
      }
      if (inFlightRefresh.current) {
        return inFlightRefresh.current;
      }
      const refresh = (async () => {
        try {
          const refreshed = await signinSilent();
          return refreshed?.id_token ?? null;
        } catch {
          return null;
        } finally {
          inFlightRefresh.current = null;
        }
      })();
      inFlightRefresh.current = refresh;
      return refresh;
    },
    [idToken, signinSilent],
  );
  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}
