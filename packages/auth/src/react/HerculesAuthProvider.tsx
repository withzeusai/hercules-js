"use client";

import { useMemo, useState } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
} from "react-oidc-context";
import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";
import { createContext, useContext } from "react";
import type { DiagnosticsConfig } from "./diagnostics";

export type HerculesAuthProviderProps = Omit<
  AuthProviderUserManagerProps,
  "userManager"
> & {
  userManagerSettings?: Partial<UserManagerSettings>;
  authority: string;
  client_id: string;
  /**
   * Failure-only auth diagnostics. Reports browser-side sign-in failures to
   * Hercules so we can debug issues that never surface clearly in server
   * logs. Successful sign-ins are never reported.
   *
   * Defaults: `enabled: true`, `reportToHercules: true`,
   * `endpoint: "/_hercules/report"` (same-origin via the Hercules worker).
   */
  diagnostics?: DiagnosticsConfig;
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
  authority: string;
  clientId: string;
  redirectUri: string;
  diagnostics: DiagnosticsConfig | undefined;
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
  diagnostics,
  ...props
}: HerculesAuthProviderProps) {
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
      }),
  );

  const contextValue = useMemo<HerculesAuthProviderContext>(
    () => ({
      userManager,
      authority,
      clientId: client_id,
      redirectUri: userManager.settings.redirect_uri,
      diagnostics,
    }),
    [userManager, authority, client_id, diagnostics],
  );

  return (
    <HerculesAuthProviderContext.Provider value={contextValue}>
      <ReactAuthProvider
        userManager={userManager}
        {...DEFAULT_AUTH_CONFIG}
        {...props}
      >
        {children}
      </ReactAuthProvider>
    </HerculesAuthProviderContext.Provider>
  );
}
