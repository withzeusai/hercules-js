"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { useCallback, useMemo } from "react";
import { useAuth } from "../client/HerculesAuthProvider";
import { useIdToken } from "../client/useIdToken";

/**
 * Bridges Hercules auth into Convex's generic auth integration. Modeled on
 * Convex's own `@convex-dev/workos` bridge for WorkOS AuthKit.
 *
 * `ConvexProviderWithAuth` calls `fetchAccessToken` when the object returned
 * here changes identity, and not otherwise. So `isAuthenticated` has to mean
 * "an ID token exists", not "a session exists": the provider is seeded with
 * `initialAuth` during SSR, which makes `user` non-null from the very first
 * client render -- before the token store has fetched anything. Reporting
 * authenticated at that point spends Convex's single request on a cold store,
 * and if it comes back empty the client stays unauthenticated for the life of
 * the page even once a valid token arrives.
 *
 * `fetchAccessToken` deliberately ignores Convex's `forceRefreshToken` flag,
 * exactly like the WorkOS bridge: it always hands back the token store's
 * current ID token, which the store refreshes on its own when the token is
 * within its expiry buffer. Convex forces a refetch right after confirming the
 * cached token and again ahead of expiry; answering both from the store means
 * no refresh grant per page load, and never an empty answer for a live session
 * -- Convex reads `null` as "signed out" and will not ask again.
 */
function useUseAuthFromHercules() {
  const { user, loading } = useAuth();
  const { idToken, loading: tokenLoading, getIdToken } = useIdToken();

  const isAuthenticated = user !== null && idToken != null;

  const fetchAccessToken = useCallback(async () => {
    try {
      const token = await getIdToken();
      return token ?? null;
    } catch {
      // Resolve rather than reject: Convex treats a rejection as "no token"
      // and will not ask again until this hook's identity changes. The token
      // store schedules its own retry and will re-render us when it lands.
      return null;
    }
  }, [getIdToken]);

  return useMemo(
    () => ({
      // Once authenticated, stay out of the loading state: a background
      // refresh must not flip Convex's `AuthLoading` back on and unmount
      // everything under `Authenticated`.
      isLoading: isAuthenticated ? false : loading || tokenLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [loading, tokenLoading, isAuthenticated, fetchAccessToken],
  );
}

/**
 * A wrapper React component which provides a {@link ConvexReactClient}
 * authenticated with Hercules Auth.
 *
 * It must be wrapped by a configured `HerculesAuthProvider`.
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
