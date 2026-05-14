"use client";

import { useMemo, useState } from "react";
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
  /** Resolved authority from the active UserManager settings. */
  authority: string;
  /** Resolved client_id from the active UserManager settings. */
  clientId: string;
  /** Resolved redirect_uri from the active UserManager settings. */
  redirectUri: string;
  diagnostics: DiagnosticsConfig | undefined;
  /** True iff browser storage is usable for OIDC state. */
  storageAvailable: boolean;
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
 * Best-effort access to localStorage for OIDC state. Some sandboxed iframes,
 * hardened browsers, and Safari private windows do one of:
 *   - throw on the `window.localStorage` getter itself
 *   - return a storage object whose `setItem` throws (private mode quota)
 *   - return a storage object that silently drops writes
 *
 * The first two are catastrophic for OIDC because `signinRedirect()` writes
 * state/nonce to the store and the callback reads it back; a broken store
 * makes every callback look like `missing_oidc_state`. We probe with a real
 * round-trip (read + write + remove) at construction time and fall back to
 * an in-memory store so the provider can still mount, sign-in can still
 * fire, and diagnostics can still report what actually happened.
 */
function pickOidcStateStore(
  override: WebStorageStateStore | undefined,
): { store: WebStorageStateStore; storageAvailable: boolean } {
  if (override) return { store: override, storageAvailable: true };
  try {
    const store = window.localStorage;
    const probeKey = "__hrc_oidc_probe__";
    store.setItem(probeKey, "1");
    store.getItem(probeKey);
    store.removeItem(probeKey);
    return {
      store: new WebStorageStateStore({ store }),
      storageAvailable: true,
    };
  } catch {
    return {
      store: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      storageAvailable: false,
    };
  }
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
  const [{ userManager, storageAvailable }] = useState(() => {
    const { store, storageAvailable: ok } = pickOidcStateStore(
      userManagerSettings?.userStore as WebStorageStateStore | undefined,
    );
    return {
      userManager: new UserManager({
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
        userStore: store,
      }),
      storageAvailable: ok,
    };
  });

  const contextValue = useMemo<HerculesAuthProviderContext>(
    () => ({
      userManager,
      // Pull from UserManager.settings so diagnostics always reflect what
      // the OIDC client actually used, not what the caller passed at the
      // top level (these can diverge when userManagerSettings overrides
      // authority/client_id).
      authority: userManager.settings.authority,
      clientId: userManager.settings.client_id,
      redirectUri: userManager.settings.redirect_uri,
      diagnostics,
      storageAvailable,
    }),
    [userManager, diagnostics, storageAvailable],
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
