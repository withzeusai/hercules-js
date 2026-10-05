/**
 * Error codes an embedded sign-in call can fail with. Server codes come from
 * Better Auth and the Hercules tenant; client codes come from this SDK. The
 * union stays open (`string & {}`) so a code added server-side still types.
 */
export const AUTH_ERROR_CODES = [
  // Credentials and accounts
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_USERNAME_OR_PASSWORD",
  "INVALID_PASSWORD",
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "USERNAME_IS_ALREADY_TAKEN",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
  "PASSWORD_COMPROMISED",
  "INVALID_TOKEN",
  "BANNED_USER",
  // One-time codes
  "INVALID_OTP",
  "OTP_EXPIRED",
  "TOO_MANY_ATTEMPTS",
  // Access
  "SIGN_IN_NOT_ALLOWLISTED",
  "SESSION_NOT_FRESH",
  "SESSION_EXPIRED",
  // Captcha
  "MISSING_RESPONSE",
  "VERIFICATION_FAILED",
  "CAPTCHA_UNAVAILABLE",
  // Social and popups
  "access_denied",
  "account_not_linked",
  "POPUP_BLOCKED",
  "POPUP_CLOSED",
  // Passkeys
  "PASSKEY_CANCELLED",
  // Transport and misuse
  "NETWORK_ERROR",
  "NO_REDIRECT",
  "NO_AUTHORIZATION_REQUEST",
] as const;

export type KnownAuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
export type AuthErrorCode = KnownAuthErrorCode | (string & {});

/** The form field an error is about, so a form can show it inline. */
export type AuthErrorField =
  | "email"
  | "password"
  | "newPassword"
  | "username"
  | "code"
  | "phoneNumber"
  | "captcha";

const FIELD_BY_CODE: Partial<Record<KnownAuthErrorCode, AuthErrorField>> = {
  INVALID_EMAIL_OR_PASSWORD: "password",
  INVALID_USERNAME_OR_PASSWORD: "password",
  INVALID_PASSWORD: "password",
  EMAIL_NOT_VERIFIED: "email",
  USER_ALREADY_EXISTS: "email",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "email",
  USERNAME_IS_ALREADY_TAKEN: "username",
  PASSWORD_TOO_SHORT: "newPassword",
  PASSWORD_TOO_LONG: "newPassword",
  PASSWORD_COMPROMISED: "newPassword",
  INVALID_OTP: "code",
  OTP_EXPIRED: "code",
  TOO_MANY_ATTEMPTS: "code",
  MISSING_RESPONSE: "captcha",
  VERIFICATION_FAILED: "captcha",
  CAPTCHA_UNAVAILABLE: "captcha",
};

export interface AuthError {
  code: AuthErrorCode;
  /** A sentence to show the user. */
  message: string;
  /** HTTP status, or 0 for errors raised in the browser. */
  status: number;
  /** The form field to show the error next to, when there is one. */
  field?: AuthErrorField;
  /** The address the allowlist turned away, when the server named it. */
  rejectedEmail?: string;
}

/** Build an `AuthError`, filling in the field the code belongs to. */
export function authError(
  code: AuthErrorCode,
  message: string,
  status = 0,
  extra: Pick<AuthError, "rejectedEmail"> = {},
): AuthError {
  const field = FIELD_BY_CODE[code as KnownAuthErrorCode];
  return { code, message, status, ...(field ? { field } : {}), ...extra };
}

/** Narrow an error to a code, e.g. `isAuthError(error, "SIGN_IN_NOT_ALLOWLISTED")`. */
export function isAuthError<C extends KnownAuthErrorCode>(
  error: AuthError | null | undefined,
  code: C,
): error is AuthError & { code: C } {
  return error?.code === code;
}
