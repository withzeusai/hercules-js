"use client";

import { useState } from "react";
import {
  AuthProvider as ReactAuthProvider,
  type AuthProviderUserManagerProps,
} from "react-oidc-context";
import {
  InMemoryWebStorage,
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";

function resolveStorage(
  getStorageFns: Array<() => Storage>,
): Storage | InMemoryWebStorage {
  if (typeof window === "undefined") {
    return new InMemoryWebStorage();
  }
  for (const getStorage of getStorageFns) {
    try {
      const storage = getStorage();
      const probeKey = "__hercules_auth_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return storage;
    } catch {
      continue;
    }
  }
  return new InMemoryWebStorage();
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
          new WebStorageStateStore({
            store: resolveStorage([
              () => window.localStorage,
              () => window.sessionStorage,
            ]),
          }),
        stateStore:
          userManagerSettings?.stateStore ??
          new WebStorageStateStore({
            store: resolveStorage([
              () => window.localStorage,
              () => window.sessionStorage,
            ]),
          }),
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
