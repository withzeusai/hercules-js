import { redirect } from "@tanstack/react-router";
import { deleteCookie, getCookies, getRequest, setCookie } from "@tanstack/react-start/server";
import * as client from "openid-client";

import { evaluateRecentAuth } from "../internal/recent-auth";
import type { NoUserInfo, UserInfo } from "../types";
import type { GetAuthURLOptions, RecentAuthResult, SignInUrlOptions } from "./auth";
import { collectClaims, userInfoFromSession } from "./claims";
import {
  DEFAULT_REDIRECT,
  DEFAULT_SCOPE,
  MAX_PENDING_SIGN_INS,
  PKCE_COOKIE_PREFIX,
  SIGN_IN_COOKIE_MAX_AGE,
  encodePkceState,
  getConfig,
  pkceCookieName,
} from "./config";
import { resolveLogoutLocation } from "./refresh";
import { cookieSecurity, resolveOrigin, resolveRedirectUri, toCookieSameSite } from "./request-url";
import { clearSessionCookies, isSessionExpired } from "./session";
import { getResolvedSession } from "./session-context";
import { readSession } from "./session-store";

// Bodies for the server functions in `auth.ts`. They live in this separate
// module, loaded via dynamic import from each handler, so nothing server-only
// (openid-client, cookie/session plumbing) is statically reachable from the
// root barrel — the client bundle must never pull this graph in.

/**
 * Map {@link GetAuthURLOptions} onto OIDC authorization-request parameters.
 * Pure so the option→parameter mapping can be unit-tested directly.
 */
export function authorizationParameters(
  options: Pick<GetAuthURLOptions, "screenHint" | "scope" | "maxAge" | "loginHint">,
  flow: { redirectUri: string; state: string; codeChallenge: string },
): Record<string, string> {
  const parameters: Record<string, string> = {
    redirect_uri: flow.redirectUri,
    scope: options.scope ?? DEFAULT_SCOPE,
    state: flow.state,
    code_challenge: flow.codeChallenge,
    code_challenge_method: "S256",
  };
  if (options.screenHint) parameters.screen_hint = options.screenHint;
  // `max_age=0` is meaningful (always force reauthentication), so gate on type.
  if (typeof options.maxAge === "number" && options.maxAge >= 0) {
    parameters.max_age = String(Math.floor(options.maxAge));
  }
  if (options.loginHint) parameters.login_hint = options.loginHint;
  return parameters;
}

/**
 * Start an Authorization Code + PKCE flow: mint a verifier/state, stash them in
 * a short-lived state-keyed cookie (alongside any `returnPathname`), and return
 * the provider's authorization URL.
 *
 * **Side effect:** sets a `${PKCE_COOKIE_PREFIX}<state>` cookie. Call this on a
 * user action or from a redirect route — not prefetched in a loader to render a
 * link — or abandoned flows pile up verifier cookies (we bound, but don't
 * eliminate, the pile-up).
 */
async function generateAuthorizationUrl(options: GetAuthURLOptions = {}): Promise<string> {
  const request = getRequest();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const redirectUri = resolveRedirectUri(request, options.redirectUri);

  const config = await getConfig();
  const authorizationUrl = client.buildAuthorizationUrl(
    config,
    authorizationParameters(options, { redirectUri, state, codeChallenge }),
  );

  // Over HTTPS default to SameSite=None; Secure so the cookie can be set even
  // when the app is embedded cross-site (this runs in a server-function fetch
  // response, and a SameSite=Lax cookie is dropped when set from a cross-site
  // response that isn't a top-level navigation). SameSite=None requires Secure,
  // so fall back to Lax over plain HTTP (local dev); overridable via
  // herculesAuthMiddleware({ cookieSameSite }).
  const { secure, sameSite } = cookieSecurity(request);
  setCookie(
    pkceCookieName(state),
    encodePkceState({
      verifier: codeVerifier,
      returnPathname: options.returnPathname,
      redirectUri,
    }),
    {
      httpOnly: true,
      secure,
      sameSite: toCookieSameSite(sameSite),
      path: "/",
      maxAge: SIGN_IN_COOKIE_MAX_AGE,
    },
  );

  // Bound the number of pending verifier cookies. `getCookies()` reflects the
  // incoming request (the cookie just set is not included), so keep the newest
  // MAX-1 of the prior flows plus this fresh one. Clear with the same
  // SameSite/Secure the cookies were set with so the deletion is honored in the
  // cross-site server-function context.
  const pending = Object.keys(getCookies()).filter((name) => name.startsWith(PKCE_COOKIE_PREFIX));
  for (const name of pending.slice(MAX_PENDING_SIGN_INS - 1)) {
    deleteCookie(name, { path: "/", secure, sameSite: toCookieSameSite(sameSite) });
  }

  return authorizationUrl.toString();
}

/**
 * Backs `getAuth`: the current session mapped to {@link UserInfo}. Resolves via
 * the per-request session context, so an expired session with a refresh token
 * is transparently refreshed (and re-sealed onto the response) instead of
 * reported as signed out.
 */
export async function getAuthBody(): Promise<UserInfo | NoUserInfo> {
  const session = await getResolvedSession();
  if (!session) return { user: null };

  return userInfoFromSession(session);
}

/**
 * Backs `signOut`: clear the session cookies and redirect to the provider's
 * end-session URL (or `returnTo`). Reads the raw session (no auto-refresh) —
 * refreshing tokens just to discard them would be a wasted grant.
 */
export async function signOutBody(returnTo?: string): Promise<never> {
  const idTokenHint = (await readSession())?.idToken;

  const request = getRequest();
  const postLogoutRedirectUri = new URL(
    returnTo ?? DEFAULT_REDIRECT,
    resolveOrigin(request),
  ).toString();
  const location = await resolveLogoutLocation(postLogoutRedirectUri, idTokenHint);

  // Clear with the same SameSite/Secure used to set the session so the cookies
  // are removed even when sign-out runs in a cross-site context.
  const { secure, sameSite } = cookieSecurity(request);
  const clearHeaders = clearSessionCookies(Object.keys(getCookies()), { secure, sameSite }).map(
    (header) => ["Set-Cookie", header] as [string, string],
  );

  throw redirect({
    href: location,
    reloadDocument: true,
    ...(clearHeaders.length > 0 ? { headers: clearHeaders } : {}),
  });
}

/** Backs `getAuthorizationUrl`. */
export async function getAuthorizationUrlBody(options?: GetAuthURLOptions): Promise<string> {
  return generateAuthorizationUrl(options ?? {});
}

/** Backs `getSignInUrl`: normalizes the string shorthand, then sign-in hint. */
export async function getSignInUrlBody(data?: string | SignInUrlOptions): Promise<string> {
  const options = typeof data === "string" ? { returnPathname: data } : (data ?? {});
  return generateAuthorizationUrl({ ...options, screenHint: "sign-in" });
}

/** Backs `getSignUpUrl`: normalizes the string shorthand, then sign-up hint. */
export async function getSignUpUrlBody(data?: string | SignInUrlOptions): Promise<string> {
  const options = typeof data === "string" ? { returnPathname: data } : (data ?? {});
  return generateAuthorizationUrl({ ...options, screenHint: "sign-up" });
}

/**
 * Backs `checkRecentAuth`: judge the session's `auth_time` claim against
 * `maxAge`. Fails closed — no session, an expired-and-unrefreshable session,
 * or a missing `auth_time` claim all report stale.
 */
export async function checkRecentAuthBody(data: { maxAge: number }): Promise<RecentAuthResult> {
  const session = await getResolvedSession();
  if (!session || isSessionExpired(session)) {
    return { authenticatedAt: null, isStale: true };
  }
  return evaluateRecentAuth({
    authTime: collectClaims(session).auth_time,
    maxAgeSeconds: data.maxAge,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}
