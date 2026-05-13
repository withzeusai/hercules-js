"use client";

import { useEffect, useRef, useState } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
  useAuth as useOidcAuth,
} from "react-oidc-context";
import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";
import { createContext, useContext } from "react";
import {
  clearHerculesImpersonationParamsFromUrl,
  getHerculesImpersonationStorageKey,
  HERCULES_IMPERSONATION_SESSION_ID_PARAM,
  HERCULES_IMPERSONATION_TOKEN_PARAM,
  rememberHerculesImpersonationSession,
} from "./impersonation-core";

export type HerculesAuthProviderProps = Omit<
  AuthProviderUserManagerProps,
  "userManager"
> & {
  userManagerSettings?: Partial<UserManagerSettings>;
  authority: string;
  client_id: string;
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

const HerculesAuthProviderContext =
  createContext<HerculesAuthProviderContext | null>(null);

export function useHerculesAuthProvider() {
  const context = useContext(HerculesAuthProviderContext);
  if (!context) {
    throw new Error("HerculesAuthProviderContext not found");
  }
  return context;
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
  ...props
}: HerculesAuthProviderProps) {
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
      }),
      impersonationStorageKey: getHerculesImpersonationStorageKey(
        effectiveAuthority,
        effectiveClientId,
      ),
    };
  });

  return (
    <HerculesAuthProviderContext.Provider
      value={{ userManager, impersonationStorageKey }}
    >
      <ReactAuthProvider
        userManager={userManager}
        {...DEFAULT_AUTH_CONFIG}
        {...props}
      >
        <HerculesImpersonationHandoff storageKey={impersonationStorageKey} />
        {children}
      </ReactAuthProvider>
    </HerculesAuthProviderContext.Provider>
  );
}

function HerculesImpersonationHandoff({ storageKey }: { storageKey: string }) {
  const auth = useOidcAuth();
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (hasStartedRef.current || typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const impersonationSessionId = url.searchParams.get(
      HERCULES_IMPERSONATION_SESSION_ID_PARAM,
    );
    const impersonationToken = url.searchParams.get(
      HERCULES_IMPERSONATION_TOKEN_PARAM,
    );
    if (!impersonationSessionId && !impersonationToken) return;
    if (!impersonationSessionId || !impersonationToken || auth.isLoading) return;

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
