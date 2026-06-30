import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookies, getRequest, setCookie } from "@tanstack/react-start/server";
import * as client from "openid-client";

import type { NoUserInfo, UserInfo } from "../types";
import { userInfoFromSession } from "./claims";
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
import { clearSessionCookies } from "./session";
import { readSession } from "./session-store";

/**
 * Options controlling how an authorization URL is built — the fields a generic
 * OIDC provider can act on.
 */
export interface GetAuthURLOptions {
  /** Hint the provider's screen (`screen_hint`); provider-dependent. */
  screenHint?: "sign-in" | "sign-up";
  /** Where to send the user after the callback completes. */
  returnPathname?: string;
  /** Override the default callback `redirect_uri`. */
  redirectUri?: string;
  /** Space-delimited scopes; defaults to `openid profile email`. */
  scope?: string;
}

/** Options accepted by {@link getSignInUrl}/{@link getSignUpUrl}. */
type SignInUrlOptions = Omit<GetAuthURLOptions, "screenHint">;

// --- authorization URL generation ------------------------------------------

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
  const parameters: Record<string, string> = {
    redirect_uri: redirectUri,
    scope: options.scope ?? DEFAULT_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (options.screenHint) parameters.screen_hint = options.screenHint;
  const authorizationUrl = client.buildAuthorizationUrl(config, parameters);

  // Over HTTPS default to SameSite=None; Secure so the cookie can be set even
  // when the app is embedded cross-site (this runs in a server-function fetch
  // response, and a SameSite=Lax cookie is dropped when set from a cross-site
  // response that isn't a top-level navigation). SameSite=None requires Secure,
  // so fall back to Lax over plain HTTP (local dev); overridable via
  // herculesAuthMiddleware({ cookieSameSite }).
  const { secure, sameSite } = cookieSecurity(request);
  setCookie(
    pkceCookieName(state),
    encodePkceState({ verifier: codeVerifier, returnPathname: options.returnPathname }),
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

// --- server functions ------------------------------------------------------

/**
 * Retrieve the current user's session, mapping OIDC claims to {@link UserInfo}.
 * Returns `{ user: null }` when there is no valid session. Safe to call in route
 * loaders (it RPCs to the server during client-side navigation).
 */
export const getAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<UserInfo | NoUserInfo> => {
    const session = await readSession();
    if (!session) return { user: null };

    return userInfoFromSession(session);
  },
);

/**
 * Sign the current user out: clear the session cookie and redirect to the
 * provider's `end_session_endpoint` (with `id_token_hint`) when one is
 * advertised, otherwise straight to `returnTo`.
 */
export const signOut = createServerFn({ method: "POST" })
  .validator((options?: { returnTo?: string }) => options)
  .handler(async ({ data }) => {
    const idTokenHint = (await readSession())?.idToken;

    const request = getRequest();
    const postLogoutRedirectUri = new URL(
      data?.returnTo ?? DEFAULT_REDIRECT,
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
  });

/**
 * Build a custom authorization URL with full control over screen hint, return
 * path, redirect URI, and scope. Sets a PKCE verifier cookie — see
 * {@link generateAuthorizationUrl}.
 */
export const getAuthorizationUrl = createServerFn({ method: "GET" })
  .validator((options?: GetAuthURLOptions) => options)
  .handler(async ({ data }): Promise<string> => generateAuthorizationUrl(data ?? {}));

/**
 * Get a sign-in URL. Accepts a `returnPathname` string shorthand or an options
 * object. Sets a PKCE verifier cookie — call on a user action or redirect route.
 */
export const getSignInUrl = createServerFn({ method: "GET" })
  .validator((data?: string | SignInUrlOptions) => data)
  .handler(async ({ data }): Promise<string> => {
    const options = typeof data === "string" ? { returnPathname: data } : (data ?? {});
    return generateAuthorizationUrl({ ...options, screenHint: "sign-in" });
  });

/**
 * Get a sign-up URL. Accepts a `returnPathname` string shorthand or an options
 * object. Sets a PKCE verifier cookie — call on a user action or redirect route.
 */
export const getSignUpUrl = createServerFn({ method: "GET" })
  .validator((data?: string | SignInUrlOptions) => data)
  .handler(async ({ data }): Promise<string> => {
    const options = typeof data === "string" ? { returnPathname: data } : (data ?? {});
    return generateAuthorizationUrl({ ...options, screenHint: "sign-up" });
  });
