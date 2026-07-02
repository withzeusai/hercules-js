import { createMiddleware } from "@tanstack/react-start";
import { type HerculesAuthMiddlewareOptions, setAuthOptions } from "./auth-options";

export type { HerculesAuthMiddlewareOptions };

/**
 * Request middleware that configures the auth SDK for your app.
 *
 * Register it in your TanStack Start instance so the configured `redirectUri`
 * and `cookieSameSite` are applied to every sign-in, callback, and session
 * cookie. Behind a TLS-terminating proxy, set `redirectUri` to the public
 * callback URL so the SDK derives the right origin and `Secure` flag instead of
 * trusting the internal `request.url`.
 *
 * @example
 * ```typescript
 * import { createStart } from "@tanstack/react-start";
 * import { herculesAuthMiddleware } from "@usehercules/auth-tanstack";
 *
 * export const startInstance = createStart(() => ({
 *   requestMiddleware: [
 *     herculesAuthMiddleware({ redirectUri: "https://app.example.com/auth/callback" }),
 *   ],
 * }));
 * ```
 */
export function herculesAuthMiddleware(options: HerculesAuthMiddlewareOptions = {}) {
  // Options are app-wide, so record them now (at app init, when the middleware
  // is constructed) rather than per request — that way the sign-in/callback
  // handlers see them even when invoked outside this middleware's chain.
  setAuthOptions(options);
  return createMiddleware({ type: "request" }).server(({ next }) => next());
}
