import { createServerOnlyFn } from "@tanstack/react-start";
import type { HandleCallbackOptions, HandleSignInOptions } from "./types";

export type {
  AuthPrompt,
  CallbackErrorParams,
  CallbackErrorReason,
  HandleAuthSuccessData,
  HandleCallbackOptions,
  HandleSignInOptions,
} from "./types";

// Route files import the handlers below from the root barrel, so this module is
// in the client graph too. Their bodies (`./route-bodies`, which pulls in
// openid-client and the session plumbing) must stay out of the client bundle,
// and a dynamic import alone does not achieve that: the client build drops the
// route's `server.handlers`, and with them every call to these builders, but
// the bundler has already found the `import()` and still emits the chunk it
// points at. `createServerOnlyFn` is replaced by TanStack Start's compiler with
// a throwing stub in the client build, before the bundler sees the `import()`,
// so the chunk is never discovered there. On the server it is the plain loader.
const loadRouteBodies = createServerOnlyFn(() => import("./route-bodies"));

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
    const { handleSignInInternal } = await loadRouteBodies();
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
 * When the user cancels at the provider or the sign-in can no longer be
 * completed (it expired, or the callback URL was reloaded or bookmarked), the
 * user is sent back into the app with `?auth_error=<reason>` instead of an
 * error body; see {@link HandleCallbackOptions.onError}.
 *
 * @public
 */
export function handleCallbackRoute(options?: HandleCallbackOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const { handleCallbackInternal } = await loadRouteBodies();
    return handleCallbackInternal(request, options);
  };
}
