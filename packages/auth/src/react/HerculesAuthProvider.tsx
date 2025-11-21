"use client";

import { useEffect, useRef } from "react";
import {
  hasAuthParams,
  AuthProvider as ReactAuthProvider,
  useAuth,
  type AuthProviderProps,
} from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";

function onSigninCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function onSignoutCallback() {
  window.location.pathname = "";
}

const DEFAULT_AUTH_CONFIG: Partial<AuthProviderProps> = {
  authority: "https://hercules.app",
  prompt: "select_account",
  response_type: "code",
  scope: "openid profile email offline_access",
  redirect_uri: `${window.location.origin}/auth/callback`,
  onSigninCallback,
  onSignoutCallback,
  userStore: new WebStorageStateStore({ store: window.localStorage }),
};

export type HerculesAuthProviderProps = AuthProviderProps;

function AutoSignIn() {
  const auth = useAuth();
  const hasTriedSignin = useRef(false);

  // automatically sign-in
  useEffect(() => {
    if (
      !hasAuthParams() &&
      !auth.isAuthenticated &&
      !auth.activeNavigator &&
      !auth.isLoading &&
      !hasTriedSignin.current
    ) {
      auth.signinRedirect();
      hasTriedSignin.current = true;
    }
  }, [auth]);

  return null;
}

/**
 * A wrapper React component which provides a {@link ReactAuthProvider}
 * configured with Hercules Auth.
 *
 * @public
 */
export function HerculesAuthProvider({
  children,
  ...props
}: HerculesAuthProviderProps) {
  return (
    <ReactAuthProvider {...DEFAULT_AUTH_CONFIG} {...props}>
      <AutoSignIn />
      {children}
    </ReactAuthProvider>
  );
}
