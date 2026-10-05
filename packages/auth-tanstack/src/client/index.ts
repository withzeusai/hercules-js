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
export { getEmbeddedSignIn, type EmbeddedSignInSettings } from "../server/auth";
export {
  createEmbeddedSignInClient,
  AUTH_ERROR_CODES,
  isAuthError,
  mountTurnstileBridge,
  readAuthError,
  type AuthError,
  type AuthErrorCode,
  type AuthErrorField,
  type AuthResult,
  type DataResult,
  type EmbeddedAuthClient,
  type Identity,
  type Passkey,
  type Session,
  type SignInConfig,
  type SignInMethod,
  type SocialProvider,
  type StepResult,
  type TurnstileBridge,
  type TurnstileBridgeOptions,
  type User,
  type WorkOSProviderName,
} from "./embedded";

export type {
  AuthContextType,
  HerculesAuthProviderProps,
  UseAccessTokenReturn,
  UseIdTokenReturn,
} from "./types";
export type { JWTPayload, TokenClaims } from "./jwt";
