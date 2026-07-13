import { getAuthOptions } from "./auth-options";
import { DEFAULT_CALLBACK_PATH, REDIRECT_URI_ENV_VARS, readEnv } from "./config";
import type { CookieOptions } from "./cookie-utils";

/**
 * The app-wide `redirect_uri`, when configured: the `herculesAuthMiddleware`
 * option, then the `HERCULES_AUTH_REDIRECT_URI`/`AUTH_REDIRECT_URI` environment
 * fallback (for apps that don't register the middleware).
 */
function configuredRedirectUri(): string | undefined {
  return getAuthOptions().redirectUri ?? readEnv(REDIRECT_URI_ENV_VARS);
}

/**
 * Origin (scheme + host) to use when building absolute URLs and as the cookie
 * context. Prefers the `redirectUri` configured on `herculesAuthMiddleware`
 * (correct behind a TLS-terminating proxy, where `request.url` only reflects
 * the internal hop) and falls back to the request's own origin.
 */
export function resolveOrigin(request: Request): string {
  const redirectUri = configuredRedirectUri();
  if (redirectUri) {
    try {
      return new URL(redirectUri).origin;
    } catch {
      // Misconfigured redirectUri — fall through to the request origin.
    }
  }
  return new URL(request.url).origin;
}

/**
 * Resolve the `redirect_uri` to send to the provider. A per-call `override`
 * wins, then the middleware-configured `redirectUri`, then the default callback
 * path resolved against {@link resolveOrigin}. Absolute values are used as-is.
 */
export function resolveRedirectUri(request: Request, override?: string): string {
  return new URL(
    override ?? configuredRedirectUri() ?? DEFAULT_CALLBACK_PATH,
    resolveOrigin(request),
  ).toString();
}

/**
 * Reconstruct the public callback URL the provider redirected to, for the
 * authorization-code token exchange.
 *
 * `openid-client`'s `authorizationCodeGrant` derives the token request's
 * `redirect_uri` from the URL it is handed (origin + path), and providers
 * require that to match the `redirect_uri` used in the authorization request.
 *
 * Prefer `sealedRedirectUri` — the exact value sent at sign-in, sealed into the
 * PKCE cookie — so a per-request `redirectUri` override is honored verbatim.
 * When it is absent (a cookie written before the value was sealed) or unparsable,
 * fall back to the resolved public origin (see {@link resolveOrigin}, correct
 * behind a TLS-terminating proxy where `request.url` is only the internal hop)
 * plus the request's own path. Either way, keep the provider's query params
 * (`code`, `state`, …) that the grant reads.
 */
export function resolveCallbackUrl(request: Request, sealedRedirectUri?: string): URL {
  const requestUrl = new URL(request.url);

  let callbackUrl: URL | undefined;
  if (sealedRedirectUri) {
    try {
      callbackUrl = new URL(sealedRedirectUri);
    } catch {
      // Unparsable sealed value — fall through to origin reconstruction.
    }
  }
  if (!callbackUrl) {
    callbackUrl = new URL(resolveOrigin(request));
    callbackUrl.pathname = requestUrl.pathname;
  }

  callbackUrl.search = requestUrl.search;
  return callbackUrl;
}

/**
 * Cookie `secure`/`sameSite` for the current request.
 *
 * Protocol comes from the middleware-configured `redirectUri` when set (correct
 * behind a TLS-terminating proxy), else from `request.url`, failing closed to
 * `secure` when neither parses. SameSite defaults to protocol-derived — `None`
 * over HTTPS (so cookies work when the app is embedded cross-site), `Lax` over
 * HTTP — and can be overridden via `herculesAuthMiddleware({ cookieSameSite })`.
 * `None` always forces `Secure` (a browser requirement).
 */
export function cookieSecurity(request: Request): {
  secure: boolean;
  sameSite: "Lax" | "None";
} {
  const { cookieSameSite } = getAuthOptions();

  let secure: boolean;
  try {
    secure = new URL(configuredRedirectUri() ?? request.url).protocol === "https:";
  } catch {
    secure = true; // Fail closed.
  }

  if (cookieSameSite === "none") return { secure: true, sameSite: "None" };
  if (cookieSameSite === "lax") return { secure, sameSite: "Lax" };
  return { secure, sameSite: secure ? "None" : "Lax" };
}

/**
 * Lowercase a {@link cookieSecurity} `sameSite` value for APIs that expect the
 * cookie-spec casing (TanStack's `setCookie`/`deleteCookie` via cookie-es).
 */
export function toCookieSameSite(
  sameSite: NonNullable<CookieOptions["sameSite"]>,
): "strict" | "lax" | "none" {
  return sameSite.toLowerCase() as "strict" | "lax" | "none";
}
