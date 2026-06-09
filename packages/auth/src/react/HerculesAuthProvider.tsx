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
  type StateStore,
  type UserManagerSettings,
} from "oidc-client-ts";
import { createContext, useContext } from "react";

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

const STATE_STORE_PREFIX = "oidc.";

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getSafeWebStorage(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const store =
      kind === "local" ? window.localStorage : window.sessionStorage;
    const probeKey = `__hercules_auth_storage_probe__${randomToken()}`;
    store.setItem(probeKey, "1");
    const ok = store.getItem(probeKey) === "1";
    store.removeItem(probeKey);
    return ok ? store : null;
  } catch {
    return null;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const target = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(target)) {
      return part.slice(target.length);
    }
  }
  return null;
}

/**
 * A {@link StateStore} backed by cookies, used only when both Web Storage
 * APIs are unavailable. It exists so the OIDC request state and PKCE verifier
 * survive the full-page redirect that `signinRedirect` performs: an
 * `InMemoryWebStorage` would be discarded by that navigation, breaking the
 * callback. Values are short-lived (PKCE/state only) and never tokens.
 */
class CookieStateStore implements StateStore {
  // SameSite=Lax so the cookie is still sent on the top-level GET navigation
  // back from the authorization server (a Strict cookie would be withheld on
  // that cross-site redirect and the callback could not read the state).
  private readonly attributes = "path=/; Secure; SameSite=Lax";
  private readonly maxAge = 600;

  set(key: string, value: string): Promise<void> {
    const name = STATE_STORE_PREFIX + key;
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${this.maxAge}; ${this.attributes}`;
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    const raw = readCookie(STATE_STORE_PREFIX + key);
    return Promise.resolve(raw === null ? null : decodeURIComponent(raw));
  }

  remove(key: string): Promise<string | null> {
    const name = STATE_STORE_PREFIX + key;
    const raw = readCookie(name);
    document.cookie = `${name}=; Max-Age=0; ${this.attributes}`;
    return Promise.resolve(raw === null ? null : decodeURIComponent(raw));
  }

  getAllKeys(): Promise<string[]> {
    if (typeof document === "undefined") return Promise.resolve([]);
    const keys: string[] = [];
    for (const part of document.cookie.split("; ")) {
      const eq = part.indexOf("=");
      const name = eq === -1 ? part : part.slice(0, eq);
      if (name.startsWith(STATE_STORE_PREFIX)) {
        keys.push(name.slice(STATE_STORE_PREFIX.length));
      }
    }
    return Promise.resolve(keys);
  }
}

function getSafeCookieStore(): CookieStateStore | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  const probeName = `__hercules_auth_cookie_probe__${randomToken()}`;
  const probeValue = randomToken();
  try {
    document.cookie = `${probeName}=${probeValue}; Max-Age=60; path=/; Secure; SameSite=Lax`;
    const ok = readCookie(probeName) === probeValue;
    document.cookie = `${probeName}=; Max-Age=0; path=/; Secure; SameSite=Lax`;
    return ok ? new CookieStateStore() : null;
  } catch {
    return null;
  }
}

function pickSafeStore(): Storage | InMemoryWebStorage {
  return (
    getSafeWebStorage("local") ??
    getSafeWebStorage("session") ??
    new InMemoryWebStorage()
  );
}

export function getSafeUserStore(): StateStore {
  return new WebStorageStateStore({ store: pickSafeStore() });
}

export function getSafeStateStore(): StateStore {
  const webStore = getSafeWebStorage("local") ?? getSafeWebStorage("session");
  if (webStore) {
    return new WebStorageStateStore({ store: webStore });
  }
  return (
    getSafeCookieStore() ??
    new WebStorageStateStore({ store: new InMemoryWebStorage() })
  );
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
        userStore: userManagerSettings?.userStore ?? getSafeUserStore(),
        stateStore: userManagerSettings?.stateStore ?? getSafeStateStore(),
      }),
  );

  return (
    <HerculesAuthProviderContext.Provider value={{ userManager }}>
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
