export {
  createEmbeddedAuthClient,
  DEFAULT_AUTH_BASE_PATH,
  readAuthError,
  readSignedQuery,
  type AuthResult,
  type DataResult,
  type EmbeddedAuthClient,
  type EmbeddedAuthClientOptions,
  type Identity,
  type Passkey,
  type Session,
  type SignInConfig,
  type SignInMethod,
  type SocialProvider,
  type StartAuthorizationOptions,
  type StepResult,
  type User,
  type WorkOSProviderName,
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
