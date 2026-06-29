import type { ClientUserInfo, Impersonator, NoUserInfo, User } from "../types";

/** Reactive auth state and actions provided by {@link HerculesAuthProvider}. */
export interface AuthContextType {
  user: User | null;
  sessionId: string | undefined;
  organizationId: string | undefined;
  role: string | undefined;
  roles: string[] | undefined;
  permissions: string[] | undefined;
  entitlements: string[] | undefined;
  featureFlags: string[] | undefined;
  impersonator: Impersonator | undefined;
  loading: boolean;
  /** Re-fetch auth state from the server. */
  getAuth: (options?: { ensureSignedIn?: boolean }) => Promise<void>;
  /** Refresh the session, returning `{ error }` on failure. */
  refreshAuth: (options?: { ensureSignedIn?: boolean }) => Promise<void | { error: string }>;
  /** Sign out, navigating to the provider's end-session URL (or `returnTo`). */
  signOut: (options?: { returnTo?: string }) => Promise<void>;
}

export interface HerculesAuthProviderProps {
  children: React.ReactNode;
  /**
   * What to do when a session is detected as expired. Defaults to reloading the
   * page; pass `false` to disable the expiration check entirely.
   */
  onSessionExpired?: false | (() => void);
  /**
   * Initial auth state (e.g. from a route loader calling `getAuth()`) to avoid a
   * loading flash. When provided, the provider skips the initial fetch.
   */
  initialAuth?: ClientUserInfo | NoUserInfo;
}

export interface UseAccessTokenReturn {
  /** Current access token. May be briefly stale; use {@link getAccessToken} when freshness matters. */
  accessToken: string | undefined;
  /** Whether a token fetch/refresh is in flight. */
  loading: boolean;
  /** The last token error, or null. */
  error: Error | null;
  /** Force a refresh, returning the new token. */
  refresh: () => Promise<string | undefined>;
  /** Get a guaranteed-fresh token, refreshing if needed. */
  getAccessToken: () => Promise<string | undefined>;
}
