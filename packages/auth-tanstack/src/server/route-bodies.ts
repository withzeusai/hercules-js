import * as client from "openid-client";
import {
  DEFAULT_REDIRECT,
  MAX_PENDING_SIGN_INS,
  PKCE_COOKIE_PREFIX,
  SIGN_IN_COOKIE_MAX_AGE,
  type PkceState,
  decodePkceState,
  encodePkceState,
  getConfig,
  pkceCookieName,
  sessionCookieDomain,
  sessionCookieMaxAge,
} from "./config";
import { parseCookieNames, parseCookies, serializeCookie } from "./cookie-utils";
import {
  AUTH_ERROR_PARAM,
  OAuthProviderError,
  OAuthStateMismatchError,
  PKCECookieMissingError,
} from "./errors";
import {
  cookieSecurity,
  resolveCallbackUrl,
  resolveOrigin,
  resolveRedirectUri,
} from "./request-url";
import { authorizationParameters } from "./server-fn-bodies";
import { type SessionData, sealSession, serializeSessionCookies } from "./session";
import type {
  CallbackErrorReason,
  HandleAuthSuccessData,
  HandleCallbackOptions,
  HandleSignInOptions,
} from "./types";

// Bodies for the route handlers in `server.ts`, loaded via dynamic import so
// the root barrel never statically reaches openid-client — see the note there.

/**
 * Append `Set-Cookie` header(s) that immediately expire the named cookie.
 *
 * Delete matching is on (name, path, domain), but the delete cookie must also
 * be accepted in the response's context. Emit both a Lax and a None; Secure
 * variant so the cookie clears whether it was originally set for a top-level
 * redirect (Lax) or an embedded/cross-site flow (None; Secure).
 */
function deleteCookie(headers: Headers, name: string): void {
  headers.append(
    "Set-Cookie",
    serializeCookie(name, "", { path: "/", maxAge: 0, sameSite: "Lax" }),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(name, "", { path: "/", maxAge: 0, sameSite: "None", secure: true }),
  );
}

/**
 * Append the delete-cookie headers for `name` onto `response`, cloning it when
 * its headers are immutable (e.g. a `Response.redirect()` from `onError`).
 */
function withDeletedCookie(response: Response, name: string): Response {
  try {
    deleteCookie(response.headers, name);
    return response;
  } catch {
    const clone = new Response(response.body, response);
    deleteCookie(clone.headers, name);
    return clone;
  }
}

/** A callback failure, before the caller's preferences shape the response. */
interface CallbackFailure {
  reason: CallbackErrorReason;
  /** Logged, and the JSON body's `error` when the default response is JSON. */
  message: string;
  /** Handed to `onError` and logged alongside `message`. */
  error?: unknown;
  /**
   * The failed flow's verifier cookie. It is expired on whichever response is
   * returned (including one produced by `onError`), so a failed flow never
   * strands its verifier; other pending sign-in flows are left untouched.
   */
  clearCookieName?: string;
  /** The failed flow's sealed PKCE state, when its cookie was readable. */
  pkce?: PkceState;
}

/**
 * Failures a user recovers from by signing in again. By default they send the
 * user back into the app instead of answering with an error body.
 */
const RECOVERABLE_REASONS: ReadonlySet<CallbackErrorReason> = new Set([
  "access_denied",
  "provider_error",
  "invalid_callback",
  "sign_in_expired",
]);

/**
 * Resolve a callback failure into a Response, honoring the caller's error
 * handling preferences (see {@link HandleCallbackOptions}). `onError` wins over
 * `errorRedirectUrl`, which in turn wins over the default: a redirect back into
 * the app for a recoverable failure, a JSON 500 otherwise.
 */
async function handleError(
  request: Request,
  failure: CallbackFailure,
  options?: HandleCallbackOptions,
): Promise<Response> {
  const { reason, message, error, clearCookieName, pkce } = failure;
  const recoverable = RECOVERABLE_REASONS.has(reason);

  // Always log before the response is shaped by caller preferences, otherwise
  // the failure is invisible whenever it's surfaced as a redirect or a generic
  // message. A recoverable failure is usually the user's doing (a cancel, a
  // stale tab), so it is a warning rather than an error.
  const log = recoverable ? console.warn : console.error;
  if (error !== undefined) {
    log(`[auth-tanstack] Sign-in callback failed (${reason}): ${message}`, error);
  } else {
    log(`[auth-tanstack] Sign-in callback failed (${reason}): ${message}`);
  }

  // `onError` is intentionally not wrapped: errors it throws propagate.
  if (options?.onError) {
    const response = await options.onError({
      error,
      request,
      reason,
      returnPathname: pkce?.returnPathname,
    });
    return clearCookieName ? withDeletedCookie(response, clearCookieName) : response;
  }

  if (options?.errorRedirectUrl) {
    try {
      const location = new URL(options.errorRedirectUrl, resolveOrigin(request)).toString();
      return redirectResponse(location, clearCookieName);
    } catch {
      // Malformed config value: warn and fall back to the default response.
      console.warn(
        `[auth-tanstack] Ignoring malformed errorRedirectUrl: ${options.errorRedirectUrl}`,
      );
    }
  }

  if (recoverable) {
    // Back to where the sign-in started, anchored to the app's origin (the
    // same origin a successful callback redirects to) so a poisoned
    // returnPathname cannot send the user off-site.
    const origin = resolveCallbackUrl(request, pkce?.redirectUri).origin;
    let location: URL;
    try {
      location = buildRedirectUrl(origin, pkce?.returnPathname ?? DEFAULT_REDIRECT);
    } catch {
      // A returnPathname the URL parser rejects (e.g. a bad host): go home.
      location = buildRedirectUrl(origin, DEFAULT_REDIRECT);
    }
    location.searchParams.set(AUTH_ERROR_PARAM, reason);
    return redirectResponse(location.toString(), clearCookieName);
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (clearCookieName) deleteCookie(headers, clearCookieName);
  return new Response(JSON.stringify({ error: message }), { status: 500, headers });
}

/** A 302 to `location`, expiring `clearCookieName` when given. */
function redirectResponse(location: string, clearCookieName?: string): Response {
  const headers = new Headers({ Location: location });
  if (clearCookieName) deleteCookie(headers, clearCookieName);
  return new Response(null, { status: 302, headers });
}

/**
 * Build the post-callback redirect, anchored to `origin`. Only the pathname,
 * query, and hash of `returnPathname` are used — an absolute URL (or a
 * protocol-relative `//host` one) cannot redirect off-origin, closing the open
 * redirect a verbatim `Location: returnPathname` would allow.
 */
export function buildRedirectUrl(origin: string, returnPathname: string): URL {
  const target = new URL(returnPathname, origin);
  const url = new URL(origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  return url;
}

/** Body of `handleSignInRoute` — see the wrapper in `server.ts` for docs. */
export async function handleSignInInternal(
  request: Request,
  options?: HandleSignInOptions,
): Promise<Response> {
  // These must be unique per authorization request and tied to the user-agent.
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const redirectUri = resolveRedirectUri(request, options?.redirectUri);

  let authorizationUrl: URL;
  try {
    const config = await getConfig();
    authorizationUrl = client.buildAuthorizationUrl(
      config,
      authorizationParameters(options ?? {}, { redirectUri, state, codeChallenge }),
    );
  } catch (error) {
    // Almost always OIDC discovery failing in getConfig() (bad issuer URL,
    // missing env var, or the provider being unreachable). Log it so the cause
    // is visible rather than swallowed behind the generic client message.
    console.error("[auth-tanstack] Failed to start sign-in:", error);
    return new Response(JSON.stringify({ error: "Failed to start sign-in" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers({ Location: authorizationUrl.toString() });

  // Stash this flow's PKCE verifier (and return path) under a state-keyed cookie
  // so concurrent sign-ins keep separate verifiers instead of clobbering a
  // shared name. Over HTTPS default to SameSite=None; Secure so it also works
  // when the app is embedded cross-site; over plain HTTP (local dev) fall back
  // to Lax. Overridable via herculesAuthMiddleware({ cookieSameSite }).
  const { secure, sameSite } = cookieSecurity(request);
  headers.append(
    "Set-Cookie",
    serializeCookie(
      pkceCookieName(state),
      encodePkceState({
        verifier: codeVerifier,
        returnPathname: options?.returnPathname,
        redirectUri,
      }),
      {
        httpOnly: true,
        secure,
        sameSite,
        path: "/",
        maxAge: SIGN_IN_COOKIE_MAX_AGE,
      },
    ),
  );

  // Bound the number of pending verifier cookies. Abandoned flows would
  // otherwise linger until they expire and could overflow the cookie header; we
  // can't tell their age, so once over the cap we expire the surplus and keep
  // this fresh flow plus a handful of genuinely concurrent ones.
  const pending = parseCookieNames(request.headers.get("cookie") ?? "").filter((name) =>
    name.startsWith(PKCE_COOKIE_PREFIX),
  );
  for (const name of pending.slice(MAX_PENDING_SIGN_INS - 1)) {
    deleteCookie(headers, name);
  }

  return new Response(null, { status: 302, headers });
}

/** Body of `handleCallbackRoute` — see the wrapper in `server.ts` for docs. */
export async function handleCallbackInternal(
  request: Request,
  options?: HandleCallbackOptions,
): Promise<Response> {
  const url = new URL(request.url);

  // The provider echoes back the `state` from the authorization request; use it
  // to locate the matching pending flow's PKCE verifier. Only a sign-in we
  // started in this browser could have set that state-keyed cookie, so its
  // presence both proves the callback belongs to that request (CSRF defense)
  // and tells concurrent flows apart. Pass `state` as `expectedState` so the
  // grant also rejects a response whose `state` is missing or mismatched.
  const state = url.searchParams.get("state");
  const verifierCookieName = state ? pkceCookieName(state) : undefined;
  const verifierCookie = verifierCookieName
    ? parseCookies(request.headers.get("cookie") ?? "")[verifierCookieName]
    : undefined;
  // A cookie that cannot be decoded is as dead as a missing one, but is still
  // expired below so it stops riding along on every request.
  const pkce = verifierCookie ? decodePkceState(verifierCookie) : undefined;
  // Expire the flow's verifier on error responses only when it exists.
  const clearCookieName = verifierCookie ? verifierCookieName : undefined;

  // The provider declined to issue a code: the user cancelled (`access_denied`)
  // or it could not complete the request. Report its reason rather than a
  // generic missing-code error, and evict the dead flow's verifier.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return handleError(
      request,
      {
        reason: providerError === "access_denied" ? "access_denied" : "provider_error",
        message: `Provider returned ${JSON.stringify(providerError)}`,
        error: new OAuthProviderError(
          providerError,
          url.searchParams.get("error_description") ?? undefined,
        ),
        clearCookieName,
        pkce,
      },
      options,
    );
  }

  if (!state || !verifierCookieName) {
    return handleError(
      request,
      {
        reason: "invalid_callback",
        message: "Missing state parameter",
        error: new OAuthStateMismatchError("Missing state parameter"),
      },
      options,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    // The flow is dead without a code: evict its verifier rather than leaving
    // it to linger until it times out.
    return handleError(
      request,
      { reason: "invalid_callback", message: "Missing code parameter", clearCookieName, pkce },
      options,
    );
  }

  if (!verifierCookie) {
    return handleError(
      request,
      {
        reason: "sign_in_expired",
        message: "Unknown or expired sign-in state",
        error: new PKCECookieMissingError(),
      },
      options,
    );
  }

  if (!pkce) {
    return handleError(
      request,
      {
        reason: "sign_in_expired",
        message: "Unreadable sign-in state",
        error: new PKCECookieMissingError(
          "The PKCE verifier cookie for this sign-in is unreadable",
        ),
        clearCookieName,
      },
      options,
    );
  }

  const { verifier: pkceCodeVerifier, returnPathname, redirectUri: sealedRedirectUri } = pkce;
  const checks: client.AuthorizationCodeGrantChecks = { pkceCodeVerifier, expectedState: state };

  // authorizationCodeGrant derives the token request's redirect_uri from this
  // URL (origin + path), and it must match the redirect_uri used in the
  // authorization request or the provider rejects the exchange. Rebuild it
  // from the redirect_uri sealed with this flow (falling back to the resolved
  // public origin behind a TLS-terminating proxy, where request.url is only
  // the internal hop) — it keeps the code/state params the grant validates.
  const callbackUrl = resolveCallbackUrl(request, sealedRedirectUri);

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    const config = await getConfig();
    tokens = await client.authorizationCodeGrant(config, callbackUrl, checks);
  } catch (error) {
    return handleError(
      request,
      {
        reason: "token_exchange_failed",
        message: "Token exchange failed",
        error,
        clearCookieName: verifierCookieName,
        pkce,
      },
      options,
    );
  }

  const claims = tokens.claims();

  // `access_token` is always present in a successful token response.
  const data: HandleAuthSuccessData = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    claims,
    state,
  };

  await options?.onSuccess?.(data);

  // Persist the tokens as a sealed session so getAuth()/signOut() can recover
  // identity and refresh. Derive an absolute expiry for the refresh-on-read
  // staleness check.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? nowSeconds + tokens.expires_in
      : typeof claims?.exp === "number"
        ? claims.exp
        : undefined;

  const session: SessionData = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  };

  let sealed: string;
  try {
    sealed = await sealSession(session);
  } catch (error) {
    return handleError(
      request,
      {
        reason: "session_failed",
        message: "Failed to persist session",
        error,
        clearCookieName: verifierCookieName,
        pkce,
      },
      options,
    );
  }

  // Anchor the redirect to the callback's own origin so a poisoned
  // returnPathname can't send the fresh session's user off-site.
  const destination = buildRedirectUrl(
    callbackUrl.origin,
    options?.returnPathname ?? returnPathname ?? DEFAULT_REDIRECT,
  );

  // Over HTTPS default to SameSite=None; Secure so the session cookie is also
  // sent when the app is embedded cross-site (e.g. read via a server-function
  // fetch from an iframe); fall back to Lax over plain HTTP (local dev).
  // Overridable via herculesAuthMiddleware({ cookieSameSite }).
  const { secure, sameSite } = cookieSecurity(request);
  const domain = sessionCookieDomain();
  const headers = new Headers({ Location: destination.toString() });

  const existingNames = parseCookieNames(request.headers.get("cookie") ?? "");
  for (const header of serializeSessionCookies(
    sealed,
    {
      httpOnly: true,
      secure,
      sameSite,
      path: "/",
      maxAge: sessionCookieMaxAge(),
      ...(domain ? { domain } : {}),
    },
    existingNames,
  )) {
    headers.append("Set-Cookie", header);
  }

  // Clear only this flow's verifier; other concurrent sign-ins keep theirs.
  deleteCookie(headers, verifierCookieName);

  return new Response(null, { status: 302, headers });
}
