/**
 * Error codes, in the style of WorkOS's authentication errors: a small,
 * stable, snake_case set an app can branch on. The server's own code is kept
 * on `rawCode`. The union stays open (`string & {}`) so a new code still types.
 */
export const AUTH_ERROR_CODES = [
  /** Wrong email, username, or password. */
  "invalid_credentials",
  /** The address must be verified first: `authenticateWithEmailVerification`. */
  "email_verification_required",
  /** An account already uses that email or username. */
  "user_already_exists",
  "password_too_short",
  "password_too_long",
  /** The password appeared in a known data breach. */
  "password_compromised",
  /** The one-time code is wrong. */
  "invalid_code",
  "code_expired",
  "too_many_attempts",
  /** A reset or verification token is invalid or expired. */
  "invalid_token",
  /** The app only lets approved people in: offer `requestAccess` when enabled. */
  "sign_in_not_allowed",
  /** The action needs a recent sign-in, or the password. */
  "reauthentication_required",
  "user_banned",
  /** The security check failed or could not load. */
  "captcha_failed",
  "rate_limited",
  /** The social provider sign-in was cancelled or failed. */
  "oauth_failed",
  /** The provider account belongs to an email linked to another sign-in method. */
  "account_not_linked",
  "popup_blocked",
  "popup_closed",
  "passkey_cancelled",
  "network_error",
  /** The call cannot run here, e.g. no sign-in to complete. A bug in the caller. */
  "invalid_request",
  "unknown_error",
] as const;

export type KnownAuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
export type AuthErrorCode = KnownAuthErrorCode | (string & {});

/** The form field an error is about, so a form can show it inline. */
export type AuthErrorField =
  | "email"
  | "username"
  | "password"
  | "newPassword"
  | "code"
  | "phoneNumber"
  | "captcha";

/** Server codes (Better Auth, Hercules) and the code each one becomes. */
const CODE_BY_SERVER_CODE: Record<string, KnownAuthErrorCode> = {
  INVALID_EMAIL_OR_PASSWORD: "invalid_credentials",
  INVALID_USERNAME_OR_PASSWORD: "invalid_credentials",
  INVALID_PASSWORD: "invalid_credentials",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "invalid_credentials",
  EMAIL_NOT_VERIFIED: "email_verification_required",
  USER_ALREADY_EXISTS: "user_already_exists",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "user_already_exists",
  USERNAME_IS_ALREADY_TAKEN: "user_already_exists",
  PASSWORD_TOO_SHORT: "password_too_short",
  PASSWORD_TOO_LONG: "password_too_long",
  PASSWORD_COMPROMISED: "password_compromised",
  INVALID_OTP: "invalid_code",
  OTP_EXPIRED: "code_expired",
  TOO_MANY_ATTEMPTS: "too_many_attempts",
  INVALID_TOKEN: "invalid_token",
  SIGN_IN_NOT_ALLOWLISTED: "sign_in_not_allowed",
  SESSION_NOT_FRESH: "reauthentication_required",
  BANNED_USER: "user_banned",
  banned_user: "user_banned",
  MISSING_RESPONSE: "captcha_failed",
  VERIFICATION_FAILED: "captcha_failed",
  access_denied: "oauth_failed",
  unable_to_create_user: "oauth_failed",
  unable_to_link_account: "oauth_failed",
  state_mismatch: "oauth_failed",
  account_not_linked: "account_not_linked",
  account_already_linked_to_different_user: "account_not_linked",
  invalid_signature: "invalid_request",
  HTTP_429: "rate_limited",
};

const FIELD_BY_CODE: Partial<Record<KnownAuthErrorCode, AuthErrorField>> = {
  invalid_credentials: "password",
  email_verification_required: "email",
  user_already_exists: "email",
  password_too_short: "newPassword",
  password_too_long: "newPassword",
  password_compromised: "newPassword",
  invalid_code: "code",
  code_expired: "code",
  too_many_attempts: "code",
  captcha_failed: "captcha",
};

export interface AuthError {
  code: AuthErrorCode;
  /** A sentence to show the user. */
  message: string;
  /** HTTP status, or 0 for errors raised in the browser. */
  status: number;
  /** The server's own code, when it differs from `code`. */
  rawCode?: string;
  /** The form field to show the error next to, when there is one. */
  field?: AuthErrorField;
  /**
   * With `email_verification_required`: pass to
   * `authenticateWithEmailVerification` with the emailed code.
   */
  pendingAuthenticationToken?: string;
  /** The address the error is about, when known. */
  email?: string;
  /** The address the allowlist turned away, when the server named it. */
  rejectedEmail?: string;
}

type ErrorExtra = Pick<AuthError, "pendingAuthenticationToken" | "email" | "rejectedEmail">;

/** Build an `AuthError` from a server or client code. */
export function authError(
  code: string,
  message: string,
  status = 0,
  extra: ErrorExtra = {},
): AuthError {
  const mapped = CODE_BY_SERVER_CODE[code];
  const known = mapped ?? ((AUTH_ERROR_CODES as readonly string[]).includes(code) ? code : null);
  const finalCode: AuthErrorCode = known ?? (status === 429 ? "rate_limited" : "unknown_error");
  const field = FIELD_BY_CODE[finalCode as KnownAuthErrorCode];
  return {
    code: finalCode,
    message,
    status,
    ...(finalCode !== code ? { rawCode: code } : {}),
    ...(field ? { field } : {}),
    ...extra,
  };
}

/** Narrow an error to a code, e.g. `isAuthError(error, "email_verification_required")`. */
export function isAuthError<C extends KnownAuthErrorCode>(
  error: AuthError | null | undefined,
  code: C,
): error is AuthError & { code: C } {
  return error?.code === code;
}
