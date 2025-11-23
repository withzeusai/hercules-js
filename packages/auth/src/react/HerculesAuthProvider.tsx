"use client";

import { useState } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderProps,
  type AuthProviderUserManagerProps,
} from "react-oidc-context";
import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";

function onSigninCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function onSignoutCallback() {
  window.location.pathname = "";
}

const DEFAULT_AUTH_CONFIG: Partial<AuthProviderProps> = {
  onSignoutCallback,
  onSigninCallback,
};

export type HerculesAuthProviderProps = AuthProviderUserManagerProps & {
  userManagerSettings: UserManagerSettings;
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
  ...props
}: HerculesAuthProviderProps) {
  const [userManager] = useState(
    () =>
      new UserManager({
        ...userManagerSettings,
        authority: userManagerSettings.authority,
        client_id: userManagerSettings.client_id,
        prompt: userManagerSettings.prompt ?? "select_account",
        response_type: userManagerSettings.response_type ?? "code",
        scope:
          userManagerSettings.scope ?? "openid profile email offline_access",
        redirect_uri:
          userManagerSettings.redirect_uri ??
          `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri:
          userManagerSettings.post_logout_redirect_uri ??
          window.location.origin,
        userStore:
          userManagerSettings.userStore ??
          new WebStorageStateStore({ store: window.localStorage }),
        
      }),
  );

  return (
    <ReactAuthProvider
      userManager={userManager}
      {...DEFAULT_AUTH_CONFIG}
      {...props}
    >
      {children}
    </ReactAuthProvider>
  );
}
