import {
  type EmbeddedSignInMetadata,
  readEmbeddedSignInMetadata,
  toEmbeddedEndpoint,
} from "@usehercules/auth-core";
import type * as client from "openid-client";

/**
 * Embedded sign-in, read from the provider's discovery document. A Hercules
 * tenant advertises it when the app renders its own sign-in UI; the app's auth
 * API is then served on the app's own origin, so the browser-facing authorize
 * and end-session endpoints move there. Token, refresh, and JWKS requests stay
 * server-to-server against the issuer. Null for any other provider.
 */
export function embeddedSignIn(config: client.Configuration): EmbeddedSignInMetadata | null {
  return readEmbeddedSignInMetadata(config.serverMetadata() as Record<string, unknown>);
}

/**
 * `endpoint` on the app's own origin when embedded sign-in is on, unchanged
 * otherwise. `appOrigin` is the origin of the flow's `redirect_uri` (or
 * `post_logout_redirect_uri`): the origin the browser is on, where the
 * embedded session cookie lives.
 */
export function browserEndpoint(
  config: client.Configuration,
  endpoint: URL,
  appOrigin: string,
): URL {
  const embedded = embeddedSignIn(config);
  return embedded ? toEmbeddedEndpoint(endpoint, appOrigin, embedded) : endpoint;
}
