"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
  useAuth,
} from "react-oidc-context";
import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";
import { withRefreshLock } from "../internal/refresh-lock";

const RECOVERY_TIMEOUT_MS = 10_000;
const LOCK_GRACE_MS = 5_000;

export type HerculesAuthProviderProps = Omit<
  AuthProviderUserManagerProps,
  "userManager"
> & {
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
}

const HerculesAuthProviderContext =
  createContext<HerculesAuthProviderContext | null>(null);

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
}: {
  children: ReactNode;
  loadingFallback: ReactNode;
}) {
  const { user, isLoading, signinSilent } = useAuth();
  const userExpired = user?.expired === true;
  const hasAttempted = useRef(false);
  const signinSilentRef = useRef(signinSilent);
  signinSilentRef.current = signinSilent;
  const [recoveryDone, setRecoveryDone] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
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
      await Promise.race([
        signinSilentRef.current().catch(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(resolve, RECOVERY_TIMEOUT_MS + LOCK_GRACE_MS),
        ),
      ]);
    }).finally(finish);
  }, [isLoading, userExpired]);

  const shouldBlock =
    recovering || (!recoveryDone && !isLoading && userExpired);

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
  const automaticSilentRenewExplicit =
    userManagerSettings?.automaticSilentRenew === true;
  const [userManager] = useState(
    () =>
      new UserManager({
        ...userManagerSettings,
        authority: userManagerSettings?.authority ?? authority,
        client_id: userManagerSettings?.client_id ?? client_id,
        prompt: userManagerSettings?.prompt ?? "select_account",
        response_type: userManagerSettings?.response_type ?? "code",
        scope:
          userManagerSettings?.scope ?? "openid profile email offline_access",
        redirect_uri:
          userManagerSettings?.redirect_uri ??
          `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri:
          userManagerSettings?.post_logout_redirect_uri ??
          window.location.origin,
        userStore:
          userManagerSettings?.userStore ??
          new WebStorageStateStore({ store: window.localStorage }),
        automaticSilentRenew:
          userManagerSettings?.automaticSilentRenew ?? false,
        silentRequestTimeoutInSeconds:
          userManagerSettings?.silentRequestTimeoutInSeconds ??
          RECOVERY_TIMEOUT_MS / 1000,
      }),
  );

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
          const isTimeout =
            err instanceof Error && err.name === "ErrorTimeout";
          if (isTimeout) {
            timeoutRetryCount++;
            const maxRetries = (
              userManager.settings as {
                maxSilentRenewTimeoutRetries?: number;
              }
            ).maxSilentRenewTimeoutRetries;
            if (maxRetries !== undefined && timeoutRetryCount > maxRetries) {
              timeoutRetryCount = 0;
              events._raiseSilentRenewError?.(err as Error);
              return;
            }
            retryTimerId = setTimeout(() => {
              retryTimerId = null;
              tryRenew();
            }, 5000);
          } else {
            timeoutRetryCount = 0;
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
    <HerculesAuthProviderContext.Provider value={{ userManager }}>
      <ReactAuthProvider
        userManager={userManager}
        {...DEFAULT_AUTH_CONFIG}
        {...props}
      >
        <AuthRecoveryGate loadingFallback={loadingFallback}>
          {children}
        </AuthRecoveryGate>
      </ReactAuthProvider>
    </HerculesAuthProviderContext.Provider>
  );
}
