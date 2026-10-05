export {
  createEmbeddedAuthClient,
  DEFAULT_AUTH_BASE_PATH,
  readAuthError,
  readSignedQuery,
  type ActiveSession,
  type AuthResult,
  type AuthStep,
  type DataResult,
  type EmbeddedAuthClient,
  type EmbeddedAuthClientOptions,
  type LinkedAccount,
  type Passkey,
  type SessionUser,
  type SignInConfig,
  type SignInMethod,
  type SocialProvider,
  type StartAuthorizationOptions,
  type StepResult,
} from "./client";
export { mountTurnstileBridge, type TurnstileBridge, type TurnstileBridgeOptions } from "./captcha";
export {
  AUTH_ERROR_CODES,
  isAuthError,
  type AuthError,
  type AuthErrorCode,
  type AuthErrorField,
  type KnownAuthErrorCode,
} from "./errors";
export {
  EMBEDDED_SIGN_IN_METADATA,
  readEmbeddedSignInMetadata,
  toEmbeddedEndpoint,
  type EmbeddedSignInMetadata,
} from "./metadata";
