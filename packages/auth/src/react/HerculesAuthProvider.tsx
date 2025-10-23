"use client";

import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderProps,
} from "react-oidc-context";

function onSigninCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function onSignoutCallback() {
  window.location.pathname = "";
}

const DEFAULT_AUTH_CONFIG: Partial<AuthProviderProps> = {
  prompt: "select_account",
  response_type: "code",
  scope: "openid profile email",
  redirect_uri: `${window.location.origin}/auth/callback`,
  onSigninCallback,
  onSignoutCallback,
};

export type HerculesAuthProviderProps = AuthProviderProps;

/**
 * A wrapper React component which provides a {@link ReactAuthProvider}
 * configured with Hercules Auth.
 *
 * @public
 */
export function HerculesAuthProvider(props: HerculesAuthProviderProps) {
  return <ReactAuthProvider {...DEFAULT_AUTH_CONFIG} {...props} />;
}
