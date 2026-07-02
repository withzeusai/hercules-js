import type { IDToken } from "openid-client";

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
   * token to be returned. Defaults to `openid profile email`.
   */
  scope?: string;
  /**
   * Where to send the user after the callback completes. Stashed with the PKCE
   * verifier and honored by {@link HandleCallbackOptions} unless that handler's
   * own `returnPathname` overrides it.
   */
  returnPathname?: string;
}

export interface HandleCallbackOptions {
  returnPathname?: string;
  onSuccess?: (data: HandleAuthSuccessData) => void | Promise<void>;
  /**
   * Custom error handler. Receives the underlying error and the original
   * request, returns a Response. Errors thrown from inside `onError` are
   * NOT caught by the SDK — they propagate up to the runtime. Wrap your
   * `onError` body in a try/catch if you want different behavior.
   *
   * If both `onError` and `errorRedirectUrl` are provided, `onError` wins
   * and `errorRedirectUrl` is ignored.
   */
  onError?: (params: { error?: unknown; request: Request }) => Response | Promise<Response>;
  /**
   * Optional URL to redirect the user to when the callback fails. Accepts
   * absolute URLs (`https://example.com/sign-in`) or relative paths
   * (`/sign-in?error=auth_failed`); relative values resolve against the
   * request origin.
   *
   * When set and `onError` is not, the SDK responds with a 302 Location
   * redirect plus the verifier-delete cookies. When `onError` is also
   * set, this option is ignored.
   *
   * The redirect URL is set at route-construction time by application
   * code, not derived from request input. Do not pass user-controlled
   * values here. The SDK does not validate the URL scheme; any value the
   * URL constructor accepts is accepted (including `javascript:` and
   * `data:`).
   *
   * If the value is malformed and the URL constructor throws, the SDK
   * logs a config warning and falls back to the path-dependent JSON
   * error response (400 or 500) with delete-cookies.
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
