import type { IDToken } from "openid-client";

/**
 * OIDC `prompt` values. Space-delimited combinations (e.g. `login consent`)
 * are also accepted.
 */
export type AuthPrompt = "login" | "none" | "consent" | "select_account" | (string & {});

export interface HandleSignInOptions {
  /**
   * Callback URL the provider redirects back to after authentication. Accepts
   * an absolute URL (`https://app.example.com/auth/callback`) or a path
   * (`/auth/callback`); a path resolves against the request origin.
   *
   * This must match both the `redirect_uri` registered with the provider and
   * the route where {@link HandleCallbackOptions} is mounted. Defaults to
   * `/auth/callback`.
   */
  redirectUri?: string;
  /**
   * Space-delimited OAuth scopes to request. `openid` is required for an ID
   * token to be returned. Defaults to `openid profile email offline_access`.
   */
  scope?: string;
  /**
   * Where to send the user after the callback completes. Stashed with the PKCE
   * verifier and honored by {@link HandleCallbackOptions} unless that handler's
   * own `returnPathname` overrides it.
   */
  returnPathname?: string;
  /**
   * OIDC `max_age` (seconds): the provider forces re-authentication when the
   * user's most recent sign-in is older. `0` always forces reauth.
   */
  maxAge?: number;
  /** OIDC `login_hint`: pre-fill the provider's login form (e.g. an email). */
  loginHint?: string;
  /**
   * OIDC `prompt`. Defaults to `login`, so the user signs in explicitly instead
   * of silently reusing the provider's existing session. Pass `select_account`,
   * `consent`, or `none` to change that, or an empty string to send no `prompt`.
   */
  prompt?: AuthPrompt;
}

/**
 * Why a callback failed, passed to {@link HandleCallbackOptions.onError}.
 *
 * The first four are recoverable: the user can simply sign in again, so by
 * default they send the user back into the app with the reason in the
 * `auth_error` query parameter (see {@link HandleCallbackOptions.onError}).
 *
 * - `access_denied`: the user cancelled or refused at the provider.
 * - `provider_error`: the provider returned another OAuth error instead of a
 *   code (e.g. `login_required` after `prompt=none`).
 * - `invalid_callback`: the callback URL had no `state` or no `code`, such as
 *   a bookmarked or hand-typed `/auth/callback`.
 * - `sign_in_expired`: no usable sign-in is pending for this `state`. The
 *   sign-in took longer than 10 minutes, was evicted by newer sign-ins in other
 *   tabs, was started in another browser, already completed (a reloaded
 *   callback), or its cookie could not be read.
 *
 * The last two point at the server or provider configuration and default to
 * an HTTP 500 JSON response:
 *
 * - `token_exchange_failed`: the provider rejected the authorization code or
 *   could not be reached.
 * - `session_failed`: the session could not be sealed (e.g. a missing or short
 *   cookie password).
 */
export type CallbackErrorReason =
  | "access_denied"
  | "provider_error"
  | "invalid_callback"
  | "sign_in_expired"
  | "token_exchange_failed"
  | "session_failed";

/** What {@link HandleCallbackOptions.onError} receives. */
export interface CallbackErrorParams {
  /**
   * The underlying error: an `OAuthProviderError`, `OAuthStateMismatchError`,
   * or `PKCECookieMissingError` for the matching reasons, the token-exchange or
   * session error otherwise, and `undefined` for a missing `code`.
   */
  error?: unknown;
  /** The callback request. */
  request: Request;
  /** Why the callback failed. */
  reason: CallbackErrorReason;
  /**
   * The `returnPathname` the failed sign-in was started with, when its PKCE
   * cookie could still be read. Not yet validated: anchor it to your origin
   * before redirecting to it.
   */
  returnPathname?: string;
}

export interface HandleCallbackOptions {
  returnPathname?: string;
  onSuccess?: (data: HandleAuthSuccessData) => void | Promise<void>;
  /**
   * Custom error handler. Receives the reason, the underlying error, and the
   * original request, and returns a Response. Errors thrown from inside
   * `onError` are NOT caught by the SDK; they propagate up to the runtime.
   * Wrap your `onError` body in a try/catch if you want different behavior.
   *
   * If both `onError` and `errorRedirectUrl` are provided, `onError` wins
   * and `errorRedirectUrl` is ignored.
   *
   * Without either, a recoverable failure (see {@link CallbackErrorReason})
   * redirects (302) back into the app: to the page the sign-in started from
   * (its `returnPathname`, anchored to the app's origin) when the flow's PKCE
   * cookie is readable, else to `/`, with `?auth_error=<reason>` appended so
   * the app can tell the user what happened. A guard that starts sign-in
   * automatically should skip doing so when `auth_error` is present, or a user
   * who cancels is sent straight back to the provider. Other failures respond
   * with a JSON `{ error }` body and HTTP 500.
   *
   * Whatever responds, the failed flow's PKCE cookie is expired on it.
   */
  onError?: (params: CallbackErrorParams) => Response | Promise<Response>;
  /**
   * Optional URL to redirect the user to when the callback fails. Accepts
   * absolute URLs (`https://example.com/sign-in`) or relative paths
   * (`/sign-in?error=auth_failed`); relative values resolve against the
   * request origin.
   *
   * When set and `onError` is not, the SDK responds with a 302 Location
   * redirect plus the verifier-delete cookies for every failure. When
   * `onError` is also set, this option is ignored.
   *
   * The redirect URL is set at route-construction time by application
   * code, not derived from request input. Do not pass user-controlled
   * values here. The SDK does not validate the URL scheme; any value the
   * URL constructor accepts is accepted (including `javascript:` and
   * `data:`).
   *
   * If the value is malformed and the URL constructor throws, the SDK
   * logs a config warning and falls back to the default handling
   * described on {@link onError}.
   */
  errorRedirectUrl?: string;
}

/**
 * Data passed to {@link HandleCallbackOptions.onSuccess} after a successful
 * authorization-code exchange. The shape mirrors what the token endpoint
 * actually returns (an OAuth 2.0 / OIDC token response) — only `accessToken`
 * is guaranteed; everything else depends on the provider, the requested
 * scopes, and the client configuration.
 */
export interface HandleAuthSuccessData {
  /** OAuth 2.0 access token. Always present. */
  accessToken: string;
  /** OIDC ID token (a JWT), when the provider returns one. */
  idToken?: string;
  /** Refresh token, when the provider issues one (e.g. with `offline_access`). */
  refreshToken?: string;
  /** Seconds until {@link accessToken} expires, when the provider reports it. */
  expiresIn?: number;
  /** Space-delimited scopes granted, when the provider echoes them back. */
  scope?: string;
  /**
   * Parsed claims of the ID token — the authenticated user's identity (`sub`,
   * `email`, any custom claims). Present only when an ID token was returned.
   */
  claims?: IDToken;
  /** The `state` value echoed back by the provider, when present. */
  state?: string;
}
