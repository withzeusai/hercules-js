import * as client from "openid-client";
import {
  DEFAULT_REDIRECT,
  DEFAULT_SCOPE,
  MAX_PENDING_SIGN_INS,
  PKCE_COOKIE_PREFIX,
  SIGN_IN_COOKIE_MAX_AGE,
  decodePkceState,
  encodePkceState,
  getConfig,
  pkceCookieName,
} from "./config";
import { parseCookieNames, parseCookies, serializeCookie } from "./cookie-utils";
import {
  cookieSecurity,
  resolveCallbackUrl,
  resolveOrigin,
  resolveRedirectUri,
} from "./request-url";
import { type SessionData, sealSession, serializeSessionCookies } from "./session";
import type { HandleAuthSuccessData, HandleCallbackOptions, HandleSignInOptions } from "./types";

export type { HandleAuthSuccessData, HandleCallbackOptions, HandleSignInOptions } from "./types";

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
 * Resolve a callback failure into a Response, honoring the caller's error
 * handling preferences (see {@link HandleCallbackOptions}). `onError` wins over
 * `errorRedirectUrl`, which in turn wins over the default JSON error response.
 *
 * When `clearCookieName` is given (the failed flow's verifier cookie) it is
 * expired; other pending sign-in flows are left untouched.
 */
async function handleError(
  request: Request,
  status: 400 | 500,
  message: string,
  error: unknown,
  options?: HandleCallbackOptions,
  clearCookieName?: string,
): Promise<Response> {
  // Always log before the response is shaped by caller preferences — otherwise
  // the failure is invisible whenever it's surfaced as a redirect or a generic
  // message. Include the underlying error when there is one.
  if (error !== undefined) {
    console.error(`[auth-tanstack] ${message} (HTTP ${status}):`, error);
  } else {
    console.error(`[auth-tanstack] ${message} (HTTP ${status})`);
  }

  // `onError` is intentionally not wrapped — errors it throws propagate.
  if (options?.onError) {
    return options.onError({ error, request });
  }

  if (options?.errorRedirectUrl) {
    try {
      const location = new URL(options.errorRedirectUrl, resolveOrigin(request)).toString();
      const headers = new Headers({ Location: location });
      if (clearCookieName) deleteCookie(headers, clearCookieName);
      return new Response(null, { status: 302, headers });
    } catch {
      // Malformed config value — warn and fall back to the JSON error response.
      console.warn(
        `[auth-tanstack] Ignoring malformed errorRedirectUrl: ${options.errorRedirectUrl}`,
      );
    }
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (clearCookieName) deleteCookie(headers, clearCookieName);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/**
 * Build a TanStack route handler that initiates the OIDC login.
 *
 * Navigating to (redirecting to) the route this is mounted on starts the
 * Authorization Code + PKCE flow: it generates a fresh `code_verifier` and
 * `state`, stashes them in short-lived cookies for {@link handleCallbackRoute}
 * to consume, and redirects the user-agent to the provider's authorization
 * endpoint.
 *
 * @public
 */
export function handleSignInRoute(options?: HandleSignInOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    return handleSignInInternal(request, options);
  };
}

async function handleSignInInternal(
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
    authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: options?.scope ?? DEFAULT_SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
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

/**
 * Build a TanStack route handler for the OAuth/OIDC callback.
 *
 * The handler completes the authorization-code grant using the PKCE
 * `code_verifier` and `state` stashed in cookies during sign-in, invokes
 * {@link HandleCallbackOptions.onSuccess} with the token response, seals the
 * resulting tokens into an HttpOnly session cookie, clears the one-time sign-in
 * cookies, and redirects the user to the resolved return path.
 *
 * @public
 */
export function handleCallbackRoute(options?: HandleCallbackOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    return handleCallbackInternal(request, options);
  };
}

async function handleCallbackInternal(
  request: Request,
  options?: HandleCallbackOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return handleError(request, 400, "Missing code parameter", undefined, options);
  }

  // The provider echoes back the `state` from the authorization request; use it
  // to locate the matching pending flow's PKCE verifier. Only a sign-in we
  // started in this browser could have set that state-keyed cookie, so its
  // presence both proves the callback belongs to that request (CSRF defense)
  // and tells concurrent flows apart. Pass `state` as `expectedState` so the
  // grant also rejects a response whose `state` is missing or mismatched.
  const state = url.searchParams.get("state");
  if (!state) {
    return handleError(request, 400, "Missing state parameter", undefined, options);
  }

  const verifierCookieName = pkceCookieName(state);
  const verifierCookie = parseCookies(request.headers.get("cookie") ?? "")[verifierCookieName];
  if (!verifierCookie) {
    return handleError(request, 400, "Unknown or expired sign-in state", undefined, options);
  }

  const {
    verifier: pkceCodeVerifier,
    returnPathname,
    redirectUri: sealedRedirectUri,
  } = decodePkceState(verifierCookie);
  const checks: client.AuthorizationCodeGrantChecks = { pkceCodeVerifier, expectedState: state };

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    const config = await getConfig();
    // authorizationCodeGrant derives the token request's redirect_uri from this
    // URL (origin + path), and it must match the redirect_uri used in the
    // authorization request or the provider rejects the exchange. Rebuild it
    // from the redirect_uri sealed with this flow (falling back to the resolved
    // public origin behind a TLS-terminating proxy, where request.url is only
    // the internal hop) — it keeps the code/state params the grant validates.
    const callbackUrl = resolveCallbackUrl(request, sealedRedirectUri);
    tokens = await client.authorizationCodeGrant(config, callbackUrl, checks);
  } catch (error) {
    return handleError(request, 500, "Token exchange failed", error, options, verifierCookieName);
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
  // identity and (later) refresh. Derive an absolute expiry for getAuth()'s
  // belt-and-suspenders staleness check.
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
      500,
      "Failed to persist session",
      error,
      options,
      verifierCookieName,
    );
  }

  // Over HTTPS default to SameSite=None; Secure so the session cookie is also
  // sent when the app is embedded cross-site (e.g. read via a server-function
  // fetch from an iframe); fall back to Lax over plain HTTP (local dev).
  // Overridable via herculesAuthMiddleware({ cookieSameSite }).
  const { secure, sameSite } = cookieSecurity(request);
  const headers = new Headers({
    Location: options?.returnPathname ?? returnPathname ?? DEFAULT_REDIRECT,
  });

  const existingNames = parseCookieNames(request.headers.get("cookie") ?? "");
  for (const header of serializeSessionCookies(
    sealed,
    {
      httpOnly: true,
      secure,
      sameSite,
      path: "/",
      maxAge: tokens.expires_in,
    },
    existingNames,
  )) {
    headers.append("Set-Cookie", header);
  }

  // Clear only this flow's verifier; other concurrent sign-ins keep theirs.
  deleteCookie(headers, verifierCookieName);

  return new Response(null, { status: 302, headers });
}
