"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { useCallback, useMemo } from "react";
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
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        if (forceRefreshToken) {
          const user = await signinSilent();
          return user?.id_token ?? null;
        }
        return idToken ?? null;
      } catch {
        return null;
      }
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
