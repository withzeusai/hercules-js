import type { NoUserInfo, User, UserInfo } from "../types";
import { fromBase64Url } from "./encoding";
import type { SessionData } from "./session";

const textDecoder = new TextDecoder();

/** Decode a JWT's payload claims without verifying the signature. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(textDecoder.decode(fromBase64Url(payload))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Merge claims from both tokens. The access token often carries authorization
 * claims (roles, org), the ID token carries identity; on overlap the ID token
 * wins. Opaque (non-JWT) access tokens simply contribute nothing.
 */
function collectClaims(session: SessionData): Record<string, unknown> {
  const fromAccess = decodeJwtClaims(session.accessToken) ?? {};
  const fromId = session.idToken ? (decodeJwtClaims(session.idToken) ?? {}) : {};
  return { ...fromAccess, ...fromId };
}

function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayClaim(claims: Record<string, unknown>, key: string): string[] | undefined {
  const value = claims[key];
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? strings : undefined;
  }
  return typeof value === "string" ? [value] : undefined;
}

function userFromClaims(claims: Record<string, unknown>): User | null {
  const id = stringClaim(claims, "sub");
  if (!id) return null;
  return {
    id,
    email: stringClaim(claims, "email") ?? "",
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    firstName: stringClaim(claims, "given_name") ?? null,
    lastName: stringClaim(claims, "family_name") ?? null,
    profilePictureUrl: stringClaim(claims, "picture") ?? null,
  };
}

/**
 * Map a sealed session to a {@link UserInfo}. Pure (no request
 * access) so it can be unit-tested directly. A session whose access token has
 * already expired, or that lacks a usable `sub`, resolves to {@link NoUserInfo}.
 */
export function userInfoFromSession(session: SessionData): UserInfo | NoUserInfo {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (session.expiresAt !== undefined && session.expiresAt <= nowSeconds) {
    return { user: null };
  }

  const claims = collectClaims(session);
  const user = userFromClaims(claims);
  if (!user) return { user: null };

  return {
    user,
    sessionId: stringClaim(claims, "sid") ?? "",
    organizationId: stringClaim(claims, "org_id"),
    role: stringClaim(claims, "role"),
    roles: stringArrayClaim(claims, "roles") ?? stringArrayClaim(claims, "cognito:groups"),
    permissions: stringArrayClaim(claims, "permissions"),
    entitlements: stringArrayClaim(claims, "entitlements"),
    featureFlags: stringArrayClaim(claims, "feature_flags"),
    accessToken: session.accessToken,
  };
}
