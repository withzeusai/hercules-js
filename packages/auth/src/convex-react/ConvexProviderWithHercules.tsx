"use client";

import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { jwtDecode } from "jwt-decode";
import { useCallback, useMemo, useRef } from "react";
import { useAuth } from "react-oidc-context";
import type { HerculesAuthProvider } from "../react/HerculesAuthProvider";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const LOCK_KEY = "__herculesAuthRefresh";

function tokenExpiresWithin(token: string, ms: number): boolean {
  try {
    const payload = jwtDecode(token);
    return payload.exp! * 1000 - Date.now() < ms;
  } catch {
    return true;
  }
}

// Cross-tab mutex: uses Web Locks API when available, falls back to a
// simple in-memory queue for environments that don't support it.
async function withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(key, callback);
  }
  return manualMutex(key, callback);
}

const mutexes = new Map<
  string,
  { running: Promise<void> | null; waiting: Array<() => Promise<void>> }
>();

async function manualMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wrapped = () =>
      callback()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          const mutex = mutexes.get(key)!;
          const next = mutex.waiting.shift();
          if (next) {
            mutex.running = next();
          } else {
            mutex.running = null;
          }
        });

    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = { running: null, waiting: [] };
      mutexes.set(key, mutex);
    }

    if (mutex.running === null) {
      mutex.running = wrapped();
    } else {
      mutex.waiting.push(wrapped);
    }
  });
}

function useUseAuthFromHercules() {
  const { isAuthenticated, user, isLoading, signinSilent } = useAuth();
  const idToken = user?.id_token;

  // Ref so the re-check inside the lock sees updates from other tabs
  const idTokenRef = useRef(idToken);
  idTokenRef.current = idToken;

  const inFlightRefresh = useRef<Promise<string | null> | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (!forceRefreshToken) {
        return idToken ?? null;
      }
      if (
        idToken != null &&
        !tokenExpiresWithin(idToken, REFRESH_THRESHOLD_MS)
      ) {
        return idToken;
      }
      // Same-tab dedup: concurrent callers share one promise
      if (inFlightRefresh.current) {
        return inFlightRefresh.current;
      }
      const refresh = withLock(LOCK_KEY, async () => {
        // Re-check after acquiring lock — another tab may have refreshed
        const currentToken = idTokenRef.current;
        if (
          currentToken != null &&
          !tokenExpiresWithin(currentToken, REFRESH_THRESHOLD_MS)
        ) {
          return currentToken;
        }
        try {
          const refreshed = await signinSilent();
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
    [idToken, signinSilent],
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
