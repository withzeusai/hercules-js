/**
 * The authenticated user, mapped from standard OIDC ID-token claims.
 */
export interface User {
  /** Stable subject identifier (`sub`). */
  id: string;
  /** Primary email (`email`); empty string when the provider omits it. */
  email: string;
  /** Whether the provider asserts the email is verified (`email_verified`). */
  emailVerified: boolean;
  /** Given name (`given_name`), when present. */
  firstName: string | null;
  /** Family name (`family_name`), when present. */
  lastName: string | null;
  /** Avatar URL (`picture`), when present. */
  profilePictureUrl: string | null;
}

/** Details of an admin impersonating the current user, when applicable. */
export interface Impersonator {
  email: string;
  reason: string | null;
}

/**
 * The conceptual server-side session. The sealed cookie stores the tokens; the
 * `user`/`impersonator` are derived from token claims by {@link getAuth}.
 */
export interface Session {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  user: User;
  impersonator?: Impersonator;
  /** Absolute access-token expiry, epoch seconds, when known. */
  expiresAt?: number;
}

/** Result of `getAuth()` when a valid session is present. */
export interface UserInfo {
  user: User;
  sessionId: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  entitlements?: string[];
  featureFlags?: string[];
  impersonator?: Impersonator;
  accessToken: string;
}

/** Result of `getAuth()` when there is no authenticated user. */
export interface NoUserInfo {
  user: null;
}

/**
 * {@link UserInfo} without the access token — the shape sent to the client (the
 * access token is fetched separately via the token store, never SSR'd).
 */
export type ClientUserInfo = Omit<UserInfo, "accessToken">;

/** The full result of `getAuth()`. */
export type AuthResult = UserInfo | NoUserInfo;

/** Standard OIDC ID-token claims this package understands. */
export interface BaseTokenClaims {
  sub: string;
  sid?: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  picture?: string;
  iat?: number;
  exp?: number;
  auth_time?: number;
}

/** Provider- or app-specific claims layered on top of {@link BaseTokenClaims}. */
export type CustomClaims = Record<string, unknown>;
