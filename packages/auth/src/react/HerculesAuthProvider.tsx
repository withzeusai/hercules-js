"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
  useAuth,
} from "react-oidc-context";
import { UserManager, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";
import { clearSessionIfInvalidGrant } from "../internal/dead-session";
import { withRefreshLock } from "../internal/refresh-lock";
import { renewRetryDelayMs, resolveMaxTimeoutRetries } from "../internal/renew-retry";
import {
  clearHerculesImpersonationParamsFromUrl,
  getHerculesImpersonationStorageKey,
  HERCULES_IMPERSONATION_SESSION_ID_PARAM,
  HERCULES_IMPERSONATION_TOKEN_PARAM,
  rememberHerculesImpersonationSession,
} from "./impersonation-core";

/** How long the recovery gate blocks render before showing the app anyway. */
const RECOVERY_TIMEOUT_MS = 10_000;

/**
 * Budget for the token request itself.
 *
 * Deliberately generous. The server rotates the refresh token and revokes the
 * old one before responding, so a client-side abort leaves us holding a token
 * the server has already retired -- and replaying it is what triggers
 * reuse detection. Giving up early is far more costly than waiting.
 */
const TOKEN_REQUEST_TIMEOUT_SECONDS = 30;

/**
 * Budget for discovery and JWKS fetches. These are separate from the token
 * request and were previously unbounded, so `silentRequestTimeoutInSeconds`
 * did not actually bound `signinSilent` end to end.
 */
const DISCOVERY_REQUEST_TIMEOUT_SECONDS = 10;

/**
 * Hard cap on holding the cross-tab refresh lock. Comfortably above the real
 * worst case (discovery + token request) so it never fires in normal
 * operation, but prevents one pathological hang from wedging every tab.
 */
const LOCK_MAX_HOLD_MS = 60_000;

export type HerculesAuthProviderProps = Omit<AuthProviderUserManagerProps, "userManager"> & {
  userManagerSettings?: Partial<UserManagerSettings>;
  authority: string;
  client_id: string;
  loadingFallback?: ReactNode;
};

function onSigninCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function onSignoutCallback() {
  window.location.pathname = "";
}

const DEFAULT_AUTH_CONFIG: Partial<HerculesAuthProviderProps> = {
  onSignoutCallback,
  onSigninCallback,
};

interface HerculesAuthProviderContext {
  userManager: UserManager;
  impersonationStorageKey: string;
}

const HerculesAuthProviderContext = createContext<HerculesAuthProviderContext | null>(null);

export function useHerculesAuthProvider() {
  const context = useContext(HerculesAuthProviderContext);
  if (!context) {
    throw new Error("HerculesAuthProviderContext not found");
  }
  return context;
}

function AuthRecoveryGate({
  children,
  loadingFallback,
  skipRecovery,
}: {
  children: ReactNode;
  loadingFallback: ReactNode;
  skipRecovery: boolean;
}) {
  const { user, isLoading, signinSilent, removeUser } = useAuth();
  const userExpired = user?.expired === true;
  const hasAttempted = useRef(false);
  const signinSilentRef = useRef(signinSilent);
  signinSilentRef.current = signinSilent;
  const removeUserRef = useRef(removeUser);
  removeUserRef.current = removeUser;
  const [recoveryDone, setRecoveryDone] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    if (skipRecovery) {
      hasAttempted.current = true;
      setRecoveryDone(true);
      return;
    }
    if (isLoading) return;
    if (hasAttempted.current) return;
    hasAttempted.current = true;

    if (!user || !userExpired) {
      setRecoveryDone(true);
      return;
    }

    setRecovering(true);
    const finish = () => {
      setRecovering(false);
      setRecoveryDone(true);
    };
    setTimeout(finish, RECOVERY_TIMEOUT_MS);

    void withRefreshLock(async () => {
      // The lock must outlive the request, not the UI timeout. Releasing it
      // early lets another tab start a second refresh while this one is still
      // in flight -- two rotations of the same token. The UI is already
      // unblocked independently by the `finish` timer above, so holding here
      // costs nothing visible. The cap is only a wedge guard.
      await Promise.race([
        signinSilentRef.current().catch(async (err: unknown) => {
          // Same dead-token problem as the expiry-timer path: without this the
          // expired user stays in storage and every later renew replays it.
          await clearSessionIfInvalidGrant({ removeUser: removeUserRef.current }, err);
          return undefined;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, LOCK_MAX_HOLD_MS)),
      ]);
    }).finally(finish);
  }, [isLoading, skipRecovery, userExpired]);

  const shouldBlock = !skipRecovery && (recovering || (!recoveryDone && !isLoading && userExpired));

  if (shouldBlock) {
    return <>{loadingFallback}</>;
  }

  return <>{children}</>;
}

/**
 * A wrapper React component which provides a {@link ReactAuthProvider}
 * configured with Hercules Auth.
 *
 * @public
 */
export function HerculesAuthProvider({
  children,
  userManagerSettings,
  authority,
  client_id,
  loadingFallback = null,
  ...props
}: HerculesAuthProviderProps) {
  const automaticSilentRenewExplicit = userManagerSettings?.automaticSilentRenew === true;
  const [{ userManager, impersonationStorageKey }] = useState(() => {
    const effectiveAuthority = userManagerSettings?.authority ?? authority;
    const effectiveClientId = userManagerSettings?.client_id ?? client_id;

    return {
      userManager: new UserManager({
        ...userManagerSettings,
        authority: effectiveAuthority,
        client_id: effectiveClientId,
        prompt: userManagerSettings?.prompt ?? "select_account",
        response_type: userManagerSettings?.response_type ?? "code",
        scope: userManagerSettings?.scope ?? "openid profile email offline_access",
        redirect_uri:
          userManagerSettings?.redirect_uri ?? `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri:
          userManagerSettings?.post_logout_redirect_uri ?? window.location.origin,
        userStore:
          userManagerSettings?.userStore ??
          new WebStorageStateStore({ store: window.localStorage }),
        automaticSilentRenew: userManagerSettings?.automaticSilentRenew ?? false,
        silentRequestTimeoutInSeconds:
          userManagerSettings?.silentRequestTimeoutInSeconds ?? TOKEN_REQUEST_TIMEOUT_SECONDS,
        // Without this, oidc-client-ts leaves discovery and JWKS fetches
        // untimed, so signinSilent can hang indefinitely regardless of the
        // token-request budget above.
        requestTimeoutInSeconds:
          userManagerSettings?.requestTimeoutInSeconds ?? DISCOVERY_REQUEST_TIMEOUT_SECONDS,
      }),
      impersonationStorageKey: getHerculesImpersonationStorageKey(
        effectiveAuthority,
        effectiveClientId,
      ),
    };
  });

  useEffect(() => {
    if (automaticSilentRenewExplicit) return;
    let retryTimerId: ReturnType<typeof setTimeout> | null = null;
    let timeoutRetryCount = 0;
    let stopped = false;
    const events = userManager.events as unknown as {
      _raiseSilentRenewError?: (e: Error) => void;
    };
    const tryRenew = () => {
      if (stopped) return;
      void withRefreshLock(async () => {
        if (stopped) return;
        try {
          await userManager.signinSilent();
          timeoutRetryCount = 0;
        } catch (err) {
          if (stopped) return;
          const isTimeout = err instanceof Error && err.name === "ErrorTimeout";
          if (isTimeout) {
            timeoutRetryCount++;
            // A timed-out renew is the one case where the server may well have
            // succeeded -- rotating and revoking our token -- and only the
            // response was lost. Each retry replays that same token, and the
            // server answers a replay by deleting every refresh token for this
            // user, on every device. So retry a bounded number of times, with
            // backoff, rather than every 5s forever.
            const maxRetries = resolveMaxTimeoutRetries(
              userManager.settings as { maxSilentRenewTimeoutRetries?: number },
            );
            if (timeoutRetryCount > maxRetries) {
              timeoutRetryCount = 0;
              events._raiseSilentRenewError?.(err as Error);
              return;
            }
            retryTimerId = setTimeout(() => {
              retryTimerId = null;
              tryRenew();
            }, renewRetryDelayMs(timeoutRetryCount));
          } else {
            timeoutRetryCount = 0;
            // A dead refresh token would otherwise stay in storage and be
            // replayed by every later renew, so the error repeats forever.
            await clearSessionIfInvalidGrant(userManager, err);
            events._raiseSilentRenewError?.(err as Error);
          }
        }
      });
    };
    const onExpiring = () => tryRenew();
    userManager.events.addAccessTokenExpiring(onExpiring);
    return () => {
      stopped = true;
      userManager.events.removeAccessTokenExpiring(onExpiring);
      if (retryTimerId !== null) clearTimeout(retryTimerId);
    };
  }, [userManager, automaticSilentRenewExplicit]);

  return (
    <HerculesAuthProviderContext.Provider value={{ userManager, impersonationStorageKey }}>
      <ReactAuthProvider userManager={userManager} {...DEFAULT_AUTH_CONFIG} {...props}>
        <HerculesImpersonationHandoff storageKey={impersonationStorageKey} />
        <AuthRecoveryGate
          loadingFallback={loadingFallback}
          skipRecovery={hasCompleteImpersonationHandoff()}
        >
          {children}
        </AuthRecoveryGate>
      </ReactAuthProvider>
    </HerculesAuthProviderContext.Provider>
  );
}

function HerculesImpersonationHandoff({ storageKey }: { storageKey: string }) {
  const auth = useAuth();
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (hasStartedRef.current || typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const impersonationSessionId = url.searchParams.get(HERCULES_IMPERSONATION_SESSION_ID_PARAM);
    const impersonationToken = url.searchParams.get(HERCULES_IMPERSONATION_TOKEN_PARAM);
    if (!impersonationSessionId && !impersonationToken) return;
    if (!impersonationSessionId || !impersonationToken) {
      window.history.replaceState(
        {},
        document.title,
        clearHerculesImpersonationParamsFromUrl(url).toString(),
      );
      return;
    }
    if (auth.isLoading) return;

    hasStartedRef.current = true;
    rememberHerculesImpersonationSession(storageKey, impersonationSessionId);
    window.history.replaceState(
      {},
      document.title,
      clearHerculesImpersonationParamsFromUrl(url).toString(),
    );

    void (async () => {
      if (auth.isAuthenticated) {
        await auth.removeUser();
      }

      await auth.signinRedirect({
        extraQueryParams: {
          [HERCULES_IMPERSONATION_SESSION_ID_PARAM]: impersonationSessionId,
          [HERCULES_IMPERSONATION_TOKEN_PARAM]: impersonationToken,
        },
      });
    })();
  }, [auth, storageKey]);

  return null;
}

function hasCompleteImpersonationHandoff(): boolean {
  if (typeof window === "undefined") return false;

  const params = new URL(window.location.href).searchParams;
  return (
    params.has(HERCULES_IMPERSONATION_SESSION_ID_PARAM) &&
    params.has(HERCULES_IMPERSONATION_TOKEN_PARAM)
  );
}
