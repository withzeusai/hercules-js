// Typed errors surfaced to `HandleCallbackOptions.onError` (and logged) when
// the callback cannot be matched to a pending sign-in flow. Kept dependency-free
// so they are safe to export from the root barrel.

/** The callback's `state` parameter was missing, so it can't be matched to a flow. */
export class OAuthStateMismatchError extends Error {
  constructor(message = "OAuth state parameter is missing or does not match") {
    super(message);
    this.name = "OAuthStateMismatchError";
  }
}

/**
 * No PKCE verifier cookie exists for the callback's `state` — the sign-in
 * expired, was evicted, or was never started in this browser.
 */
export class PKCECookieMissingError extends Error {
  constructor(message = "No PKCE verifier cookie was found for this sign-in") {
    super(message);
    this.name = "PKCECookieMissingError";
  }
}
