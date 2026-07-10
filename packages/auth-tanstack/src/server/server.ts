import type { HandleCallbackOptions, HandleSignInOptions } from "./types";

export type { HandleAuthSuccessData, HandleCallbackOptions, HandleSignInOptions } from "./types";

// The route handlers are exported from the root barrel, which route files
// import isomorphically, so their bodies (`./route-bodies`, which pulls in
// openid-client and the session plumbing) are loaded via dynamic import — the
// client bundle must never statically reach that graph.

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
    const { handleSignInInternal } = await import("./route-bodies");
    return handleSignInInternal(request, options);
  };
}

/**
 * Build a TanStack route handler for the OAuth/OIDC callback.
 *
 * The handler completes the authorization-code grant using the PKCE
 * `code_verifier` and `state` stashed in cookies during sign-in, invokes
 * {@link HandleCallbackOptions.onSuccess} with the token response, seals the
 * resulting tokens into an HttpOnly session cookie, clears the one-time sign-in
 * cookies, and redirects the user to the resolved return path (anchored to the
 * callback's origin).
 *
 * @public
 */
export function handleCallbackRoute(options?: HandleCallbackOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const { handleCallbackInternal } = await import("./route-bodies");
    return handleCallbackInternal(request, options);
  };
}
