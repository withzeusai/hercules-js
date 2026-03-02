"use client";

import { createContext, useContext, useState } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
} from "react-oidc-context";
import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";

const UserManagerContext = createContext<UserManager | null>(null);

/**
 * Returns the {@link UserManager} instance from the nearest
 * {@link HerculesAuthProvider}.
 *
 * @public
 */
export function useUserManager(): UserManager {
  const userManager = useContext(UserManagerContext);
  if (!userManager) {
    throw new Error(
      "useUserManager must be used within a HerculesAuthProvider",
    );
  }
  return userManager;
}

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

  return (
    <UserManagerContext.Provider value={userManager}>
      <ReactAuthProvider
        userManager={userManager}
        {...DEFAULT_AUTH_CONFIG}
        {...props}
      >
        {children}
      </ReactAuthProvider>
    </UserManagerContext.Provider>
  );
}
