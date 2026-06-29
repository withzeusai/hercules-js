/**
 * Minimal, dependency-free JWT decoding for the client. Decodes (does NOT
 * verify) the payload — verification happens server-side during the token
 * exchange/refresh. Self-contained so the client bundle pulls in no server code.
 */

/** Standard registered claims plus common authorization claims on an access token. */
export interface JWTPayload {
  /** Session ID. */
  sid?: string;
  /** Issuer. */
  iss?: string;
  /** Subject (user id). */
  sub?: string;
  /** Audience. */
  aud?: string | string[];
  /** Expiration time (epoch seconds). */
  exp?: number;
  /** Issued-at time (epoch seconds). */
  iat?: number;
  /** JWT ID. */
  jti?: string;
  /** Active organization id. */
  org_id?: string;
  /** Single role. */
  role?: string;
  /** Roles. */
  roles?: string[];
  /** Permissions. */
  permissions?: string[];
  /** Time of authentication (epoch seconds). */
  auth_time?: number;
}

/** Decoded claims: the known {@link JWTPayload} fields plus any custom claims. */
export type TokenClaims<T = Record<string, unknown>> = Partial<JWTPayload & T>;

/** Decode a base64url segment to a UTF-8 string. */
function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decode a JWT's payload claims. Throws on a structurally invalid token.
 */
export function decodeJwt<T = Record<string, unknown>>(token: string): { payload: TokenClaims<T> } {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Invalid JWT format");
  }
  try {
    return { payload: JSON.parse(decodeBase64Url(parts[1])) as TokenClaims<T> };
  } catch (error) {
    throw new Error(`Failed to decode JWT: ${error instanceof Error ? error.message : String(error)}`);
  }
}
