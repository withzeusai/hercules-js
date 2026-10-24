// Typed errors surfaced to `HandleCallbackOptions.onError` (and logged) when
// the callback cannot be matched to a pending sign-in flow. Kept dependency-free
// so they are safe to export from the root barrel.

/**
 * Query parameter that carries the reason when a failed callback sends the
 * user back into the app, e.g. `/?auth_error=access_denied`. Its value is
 * always one of the fixed recoverable reasons (`access_denied`,
 * `provider_error`, `invalid_callback`, `sign_in_expired`), never provider
 * text, so the app can safely show a message for it.
 */
export const AUTH_ERROR_PARAM = "auth_error";

/** The callback's `state` parameter was missing, so it can't be matched to a flow. */
export class OAuthStateMismatchError extends Error {
  constructor(message = "OAuth state parameter is missing or does not match") {
    super(message);
    this.name = "OAuthStateMismatchError";
  }
}

/**
 * No usable PKCE verifier cookie exists for the callback's `state`: the sign-in
 * expired, was evicted, was never started in this browser, or its cookie could
 * not be read.
 */
export class PKCECookieMissingError extends Error {
  constructor(message = "No PKCE verifier cookie was found for this sign-in") {
    super(message);
    this.name = "PKCECookieMissingError";
  }
}

/**
 * The provider answered the callback with an OAuth `error` instead of a code,
 * for example `access_denied` when the user cancelled sign-in.
 */
export class OAuthProviderError extends Error {
  /** The provider's `error` value, e.g. `access_denied` or `login_required`. */
  readonly code: string;
  /** The provider's `error_description`, when it sent one. */
  readonly description?: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthProviderError";
    this.code = code;
    this.description = description;
  }
}
