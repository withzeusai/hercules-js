"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { useAuth } from "../client/HerculesAuthProvider";
import { useIdToken } from "../client/useIdToken";

type AuthClient = Pick<ConvexReactClient, "setAuth">;

const ClientContext = createContext<AuthClient | null>(null);

/**
 * Clients whose `expectAuth` hold is over: Convex handed them a token, or this
 * provider released them. Module scope, so a remount never pauses one again.
 */
const settledClients = new WeakSet<AuthClient>();

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
  const isLoading = isAuthenticated ? false : loading || tokenLoading;

  useReleaseWhenSignedOut(useContext(ClientContext), isLoading, isAuthenticated);

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
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}

/**
 * A client created with `expectAuth: true` holds every request until its first
 * `setAuth`, but `ConvexProviderWithAuth` only calls `setAuth` for a signed-in
 * session. Once auth settles without a token (signed out, or a session that
 * yields no ID token) and Convex was never handed one, give the client a
 * fetcher that answers "no token": Convex then resumes the socket
 * unauthenticated. A client created without `expectAuth` was never paused, so
 * for it this is a pause and resume in the same tick.
 */
function useReleaseWhenSignedOut(
  client: AuthClient | null,
  isLoading: boolean,
  isAuthenticated: boolean,
) {
  useEffect(() => {
    if (!client || settledClients.has(client)) return;
    if (isAuthenticated) {
      // Convex's own `setAuth` now owns the socket's pause state, and
      // replacing its fetcher would drop the session's token refresh.
      settledClients.add(client);
      return;
    }
    if (isLoading) return;
    settledClients.add(client);
    client.setAuth(
      async () => null,
      () => {},
    );
  }, [client, isLoading, isAuthenticated]);
}

/**
 * A wrapper React component which provides a {@link ConvexReactClient}
 * authenticated with Hercules Auth.
 *
 * It must be wrapped by a configured `HerculesAuthProvider`.
 *
 * With server rendering, create the client with `expectAuth: true` (for
 * example `new ConvexQueryClient(url, { expectAuth: true })`). Queries
 * dehydrated from the server subscribe as soon as the client boots, before
 * this provider can send the session's ID token, so without it they first run
 * signed out and the empty results replace the signed-in data the server
 * rendered, which fails hydration. With `expectAuth`, requests wait for the
 * token; this provider releases the client for signed-out visitors.
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
    <ClientContext.Provider value={client}>
      <ConvexProviderWithAuth client={client} useAuth={useUseAuthFromHercules}>
        {children}
      </ConvexProviderWithAuth>
    </ClientContext.Provider>
  );
}
