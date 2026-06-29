/**
 * @usehercules/auth-tanstack/client
 *
 * Client-side React hooks and provider for OIDC auth with TanStack Start.
 */

export { HerculesAuthProvider, useAuth } from "./HerculesAuthProvider";
export { useAccessToken } from "./useAccessToken";
export { useIdToken } from "./useIdToken";
export { useTokenClaims } from "./useTokenClaims";
export { useRecentAuth } from "./useRecentAuth";

export { getAuthAction } from "../server/actions";

export type { AuthContextType, HerculesAuthProviderProps, UseAccessTokenReturn, UseIdTokenReturn } from "./types";
export type { JWTPayload, TokenClaims } from "./jwt";
