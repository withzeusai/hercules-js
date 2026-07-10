import { createServerFn } from "@tanstack/react-start";

import type { NoUserInfo, UserInfo } from "../types";

// These server functions are loader-safe and exported from the root barrel, so
// route files import this module isomorphically. Each handler dynamically
// imports its body (`./server-fn-bodies`, which pulls in `openid-client` and
// the cookie/session plumbing) so nothing server-only is statically reachable
// from the client bundle — the createServerFn boundary replaces each handler
// with an RPC stub on the client.

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
  /**
   * OIDC `max_age` (seconds): the provider forces re-authentication when the
   * user's most recent sign-in is older. Pair with {@link checkRecentAuth} to
   * enforce recency for sensitive actions; `0` always forces reauth.
   */
  maxAge?: number;
  /** OIDC `login_hint`: pre-fill the provider's login form (e.g. an email). */
  loginHint?: string;
}

/** Options accepted by {@link getSignInUrl}/{@link getSignUpUrl}. */
export type SignInUrlOptions = Omit<GetAuthURLOptions, "screenHint">;

/** Result of {@link checkRecentAuth}. */
export interface RecentAuthResult {
  /** When the user last authenticated, or null when unknown (treated as stale). */
  authenticatedAt: Date | null;
  /** Whether the last authentication is older than the requested `maxAge`. */
  isStale: boolean;
}

/**
 * Retrieve the current user's session, mapping OIDC claims to {@link UserInfo}.
 * Returns `{ user: null }` when there is no valid session. Safe to call in route
 * loaders (it RPCs to the server during client-side navigation). An expired
 * session with a refresh token is refreshed transparently.
 */
export const getAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<UserInfo | NoUserInfo> => {
    const { getAuthBody } = await import("./server-fn-bodies");
    return getAuthBody();
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
    const { signOutBody } = await import("./server-fn-bodies");
    return signOutBody(data?.returnTo);
  });

/**
 * Build a custom authorization URL with full control over screen hint, return
 * path, redirect URI, scope, `max_age`, and `login_hint`. Sets a PKCE verifier
 * cookie — call on a user action or redirect route, not prefetched in a loader.
 */
export const getAuthorizationUrl = createServerFn({ method: "GET" })
  .validator((options?: GetAuthURLOptions) => options)
  .handler(async ({ data }): Promise<string> => {
    const { getAuthorizationUrlBody } = await import("./server-fn-bodies");
    return getAuthorizationUrlBody(data);
  });

/**
 * Get a sign-in URL. Accepts a `returnPathname` string shorthand or an options
 * object. Sets a PKCE verifier cookie — call on a user action or redirect route.
 */
export const getSignInUrl = createServerFn({ method: "GET" })
  .validator((data?: string | SignInUrlOptions) => data)
  .handler(async ({ data }): Promise<string> => {
    const { getSignInUrlBody } = await import("./server-fn-bodies");
    return getSignInUrlBody(data);
  });

/**
 * Get a sign-up URL. Accepts a `returnPathname` string shorthand or an options
 * object. Sets a PKCE verifier cookie — call on a user action or redirect route.
 */
export const getSignUpUrl = createServerFn({ method: "GET" })
  .validator((data?: string | SignInUrlOptions) => data)
  .handler(async ({ data }): Promise<string> => {
    const { getSignUpUrlBody } = await import("./server-fn-bodies");
    return getSignUpUrlBody(data);
  });

/**
 * Check whether the user's most recent authentication is older than `maxAge`
 * seconds, from the session's `auth_time` claim. Fails closed: no session or no
 * `auth_time` reports stale.
 *
 * @example
 * ```typescript
 * const { isStale } = await checkRecentAuth({ data: { maxAge: 300 } });
 * if (isStale) return { status: "reauth_required" };
 * ```
 *
 * @remarks
 * To send the user through re-authentication, redirect to sign-in with
 * `maxAge` (e.g. `getSignInUrl({ data: { maxAge: 300 } })`), which forwards
 * OIDC `max_age` so the provider forces a fresh login when the last one is
 * older. The client-side `useRecentAuth` hook is presentation-only; this is
 * the enforcement half.
 */
export const checkRecentAuth = createServerFn({ method: "GET" })
  .validator((options: { maxAge: number }) => options)
  .handler(async ({ data }): Promise<RecentAuthResult> => {
    const { checkRecentAuthBody } = await import("./server-fn-bodies");
    return checkRecentAuthBody(data);
  });
