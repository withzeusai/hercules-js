import { createContext, useCallback, useContext, useEffect, useState } from "react";
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
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const hasSession = await checkSessionAction();
        if (!hasSession) {
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
  }, [onSessionExpired]);

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

  useEffect(() => {
    if (context && ensureSignedIn && !context.user && !context.loading) {
      void context.getAuth({ ensureSignedIn });
    }
  }, [ensureSignedIn, context]);

  if (!context) {
    throw new Error("useAuth must be used within a HerculesAuthProvider");
  }

  return context;
}
