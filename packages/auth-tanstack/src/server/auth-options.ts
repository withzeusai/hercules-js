/**
 * Options for {@link herculesAuthMiddleware}.
 *
 * These are app-wide (one auth setup per deployment), so they are stored in a
 * module-level holder set when the middleware is constructed rather than passed
 * through per-request context — see {@link setAuthOptions}.
 */
export interface HerculesAuthMiddlewareOptions {
  /**
   * Public callback URL the provider redirects back to, e.g.
   * `https://app.example.com/auth/callback`.
   *
   * Behind a TLS-terminating proxy (a load balancer, or preview/deploy infra),
   * Node only sees the internal hop, so `request.url` reports `http://` on an
   * internal port rather than the browser-facing scheme/host. Configuring this
   * is how the SDK learns the real origin and protocol: it becomes the default
   * `redirect_uri` sent to the provider and the source of the cookie `Secure`
   * flag. When omitted, the SDK falls back to `request.url`.
   */
  redirectUri?: string;
  /**
   * SameSite attribute for the auth cookies (PKCE verifier and session).
   *
   * Defaults to protocol-derived: `none` over HTTPS (so cookies work when the
   * app is embedded cross-site, e.g. in an iframe) and `lax` over HTTP (local
   * dev). Set `"none"` to force the embed-safe behavior even when the protocol
   * can't be detected as HTTPS; `"none"` always implies `Secure`. `"strict"`
   * is intentionally unsupported — it would drop the verifier on the provider's
   * redirect back and break sign-in.
   */
  cookieSameSite?: "lax" | "none";
}

let current: HerculesAuthMiddlewareOptions = {};

/** Record the options configured on {@link herculesAuthMiddleware}. */
export function setAuthOptions(options: HerculesAuthMiddlewareOptions): void {
  current = options;
}

/** The options configured on {@link herculesAuthMiddleware} (empty if unset). */
export function getAuthOptions(): HerculesAuthMiddlewareOptions {
  return current;
}
