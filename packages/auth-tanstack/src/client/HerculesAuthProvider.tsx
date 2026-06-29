import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { checkSessionAction, getAuthAction, getSignOutUrl, refreshAuthAction } from "../server/actions";
import type { ClientUserInfo, Impersonator, NoUserInfo, User } from "../types";
import type { AuthContextType, HerculesAuthProviderProps } from "./types";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getProps(auth: ClientUserInfo | NoUserInfo | undefined) {
  return {
    user: auth && "user" in auth ? auth.user : null,
    sessionId: auth && "sessionId" in auth ? auth.sessionId : undefined,
    organizationId: auth && "organizationId" in auth ? auth.organizationId : undefined,
    role: auth && "role" in auth ? auth.role : undefined,
    roles: auth && "roles" in auth ? auth.roles : undefined,
    permissions: auth && "permissions" in auth ? auth.permissions : undefined,
    entitlements: auth && "entitlements" in auth ? auth.entitlements : undefined,
    featureFlags: auth && "featureFlags" in auth ? auth.featureFlags : undefined,
    impersonator: auth && "impersonator" in auth ? auth.impersonator : undefined,
  };
}

export function HerculesAuthProvider({ children, onSessionExpired, initialAuth }: HerculesAuthProviderProps) {
  const initial = getProps(initialAuth);
  const [user, setUser] = useState<User | null>(initial.user);
  const [sessionId, setSessionId] = useState(initial.sessionId);
  const [organizationId, setOrganizationId] = useState(initial.organizationId);
  const [role, setRole] = useState(initial.role);
  const [roles, setRoles] = useState(initial.roles);
  const [permissions, setPermissions] = useState(initial.permissions);
  const [entitlements, setEntitlements] = useState(initial.entitlements);
  const [featureFlags, setFeatureFlags] = useState(initial.featureFlags);
  const [impersonator, setImpersonator] = useState<Impersonator | undefined>(initial.impersonator);
  const [loading, setLoading] = useState(!initialAuth);

  // Latest user, read by the focus/visibility listener without making it a
  // dependency (which would tear down and reinstall the listener each change).
  const userRef = useRef<User | null>(initial.user);
  userRef.current = user;

  const apply = useCallback((auth: ClientUserInfo | NoUserInfo | undefined) => {
    const props = getProps(auth);
    setUser(props.user);
    setSessionId(props.sessionId);
    setOrganizationId(props.organizationId);
    setRole(props.role);
    setRoles(props.roles);
    setPermissions(props.permissions);
    setEntitlements(props.entitlements);
    setFeatureFlags(props.featureFlags);
    setImpersonator(props.impersonator);
  }, []);

  const getAuth = useCallback(async () => {
    setLoading(true);
    try {
      apply(await getAuthAction());
    } catch {
      apply({ user: null });
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const refreshAuth = useCallback(async (): Promise<void | { error: string }> => {
    setLoading(true);
    try {
      apply(await refreshAuthAction());
    } catch (error) {
      return error instanceof Error ? { error: error.message } : { error: String(error) };
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const signOut = useCallback(async ({ returnTo = "/" }: { returnTo?: string } = {}) => {
    try {
      const { url } = await getSignOutUrl({ data: { returnTo } });
      window.location.href = url;
    } catch {
      window.location.href = returnTo;
    }
  }, []);

  // Initial fetch — skipped when auth was pre-loaded via a route loader.
  useEffect(() => {
    if (!initialAuth) void getAuth();
    // Run once on mount; getAuth/initialAuth are stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect session expiration when the tab regains focus/visibility.
  useEffect(() => {
    if (onSessionExpired === false) return;

    let inFlight = false;
    const check = async () => {
      // Only meaningful when a session currently exists. Without this gate a
      // signed-out user (public route, post sign-out, already-expired session)
      // would get `hasSession === false` and be reloaded on every focus.
      if (inFlight || !userRef.current || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const hasSession = await checkSessionAction();
        if (!hasSession) {
          // Reflect the expiry locally so the UI updates and the gate above
          // suppresses further checks even if we don't reload.
          apply({ user: null });
          if (onSessionExpired) onSessionExpired();
          else window.location.reload();
        }
      } catch {
        // Network error — leave the session as-is rather than forcing a reload.
      } finally {
        inFlight = false;
      }
    };

    window.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [onSessionExpired, apply]);

  return (
    <AuthContext.Provider
      value={{
        user,
        sessionId,
        organizationId,
        role,
        roles,
        permissions,
        entitlements,
        featureFlags,
        impersonator,
        loading,
        getAuth,
        refreshAuth,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Access reactive auth state and actions. Must be used within a
 * {@link HerculesAuthProvider}.
 *
 * @param options.ensureSignedIn When true, re-fetches auth if there is no user
 *   and nothing is in flight (does not itself redirect to sign-in).
 */
export function useAuth(options: { ensureSignedIn?: boolean } = {}): AuthContextType {
  const { ensureSignedIn = false } = options;
  const context = useContext(AuthContext);

  // Gate the ensure-signed-in fetch to a single attempt. `getAuth` toggles
  // `loading`, which re-runs this effect; without the guard a signed-out result
  // (`{ user: null }`) would satisfy the condition again and re-fetch forever.
  const attemptedRef = useRef(false);
  const user = context?.user;
  const loading = context?.loading;
  const getAuth = context?.getAuth;

  useEffect(() => {
    if (!ensureSignedIn || !getAuth) return;
    if (user) {
      // Signed in — reset so a later sign-out can trigger one fresh attempt.
      attemptedRef.current = false;
      return;
    }
    // Signed out: fetch once (e.g. to confirm a seeded `initialAuth: { user: null }`),
    // then stop. Callers wanting a redirect can act on the resolved `user`.
    if (!loading && !attemptedRef.current) {
      attemptedRef.current = true;
      void getAuth({ ensureSignedIn });
    }
  }, [ensureSignedIn, user, loading, getAuth]);

  if (!context) {
    throw new Error("useAuth must be used within a HerculesAuthProvider");
  }

  return context;
}
