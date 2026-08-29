"use client";

import type { ReactNode, RefObject } from "react";
import { ConvexProviderWithAuth, useConvexAuth, type ConvexReactClient } from "convex/react";
import { jwtDecode } from "jwt-decode";
import { ErrorResponse, ErrorTimeout } from "oidc-client-ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "react-oidc-context";
import { withRefreshLock } from "../internal/refresh-lock";
import { useHerculesAuthProvider, type HerculesAuthProvider } from "../react/HerculesAuthProvider";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const BackendAuthContext = createContext<RefObject<boolean> | null>(null);

function tokenExpiresWithin(token: string, ms: number): boolean {
  try {
    const payload = jwtDecode(token);
    return (
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 - Date.now() <= ms
    );
  } catch {
    return true;
  }
}

function isTransientRefreshError(error: unknown): boolean {
  if (error instanceof ErrorResponse) {
    return error.error === "temporarily_unavailable" || error.error === "server_error";
  }
  return error instanceof ErrorTimeout || error instanceof TypeError;
}

function useUseAuthFromHercules() {
  const backendAuth = useContext(BackendAuthContext);
  const { isAuthenticated, user, isLoading } = useAuth();
  const { userManager } = useHerculesAuthProvider();
  const idToken = user?.id_token;
  const issuer = user?.profile?.iss;
  const subject = user?.profile?.sub;
  const identityRef = useRef({ issuer, subject });
  identityRef.current = { issuer, subject };

  const idTokenRef = useRef(idToken);
  idTokenRef.current = idToken;

  const userManagerRef = useRef(userManager);
  userManagerRef.current = userManager;

  const inFlightRefresh = useRef<Promise<string | null> | null>(null);
  const failedRefreshToken = useRef<string | null | undefined>(undefined);
  const [recoveryVersion, setRecoveryVersion] = useState(0);

  useEffect(() => {
    if (
      failedRefreshToken.current !== undefined &&
      idToken != null &&
      idToken !== failedRefreshToken.current &&
      !tokenExpiresWithin(idToken, 0)
    ) {
      // Convex stops refetching after a failed renewal, even if OIDC later recovers.
      failedRefreshToken.current = undefined;
      if (!backendAuth?.current) setRecoveryVersion((version) => version + 1);
    }
  }, [idToken, backendAuth]);

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
        const isCurrentIdentity = () =>
          identityRef.current.issuer === issuer && identityRef.current.subject === subject;
        if (!isCurrentIdentity()) return null;
        const tokenAfterLock = idTokenRef.current;
        if (tokenAfterLock != null && !tokenExpiresWithin(tokenAfterLock, REFRESH_THRESHOLD_MS)) {
          return tokenAfterLock;
        }
        try {
          // react-oidc-context turns every renewal error into null, losing its cause.
          const refreshed = await userManagerRef.current.signinSilent();
          if (!isCurrentIdentity()) return null;
          failedRefreshToken.current = refreshed?.id_token
            ? undefined
            : (idTokenRef.current ?? null);
          return refreshed?.id_token ?? null;
        } catch (error) {
          if (!isCurrentIdentity()) return null;
          failedRefreshToken.current = idTokenRef.current ?? null;
          if (
            isTransientRefreshError(error) &&
            tokenAfterLock != null &&
            tokenAfterLock === idTokenRef.current &&
            !tokenExpiresWithin(tokenAfterLock, 0)
          ) {
            return tokenAfterLock;
          }
          await userManagerRef.current.events
            ._raiseSilentRenewError(error instanceof Error ? error : new Error(String(error)))
            .catch(() => undefined);
          return null;
        }
      }).finally(() => {
        inFlightRefresh.current = null;
      });
      inFlightRefresh.current = refresh;
      return refresh;
    },
    [issuer, subject, recoveryVersion],
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

function BackendAuthObserver({ authState }: { authState: RefObject<boolean> }) {
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => {
    authState.current = isAuthenticated;
  }, [authState, isAuthenticated]);
  return null;
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
  const backendAuth = useRef(false);
  return (
    <BackendAuthContext.Provider value={backendAuth}>
      <ConvexProviderWithAuth client={client} useAuth={useUseAuthFromHercules}>
        <BackendAuthObserver authState={backendAuth} />
        {children}
      </ConvexProviderWithAuth>
    </BackendAuthContext.Provider>
  );
}
