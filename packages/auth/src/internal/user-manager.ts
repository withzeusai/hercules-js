import { readEmbeddedSignInMetadata, toEmbeddedEndpoint } from "@usehercules/auth-core";
import { jwtDecode } from "jwt-decode";
import {
  UserManager,
  type CreateSigninRequestArgs,
  type CreateSignoutRequestArgs,
  type IWindow,
  type NavigateResponse,
} from "oidc-client-ts";

function logoutRedirectUrl(requestUrl: string, clientId: string): string {
  const url = new URL(requestUrl);
  const hints = url.searchParams.getAll("id_token_hint");
  const idToken = hints[0];
  if (!idToken || hints.length !== 1) return requestUrl;

  let sessionId: unknown;
  try {
    sessionId = jwtDecode<{ sid?: unknown }>(idToken).sid;
  } catch {
    return requestUrl;
  }
  if (typeof sessionId === "string" && sessionId.length > 0) return requestUrl;

  const clients = url.searchParams.getAll("client_id");
  if (clients.length > 1 || (clients.length === 1 && clients[0] !== clientId)) return requestUrl;

  url.searchParams.delete("id_token_hint");
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

const END_SESSION_TIMEOUT_MS = 5000;

function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function endSessionInBackground(url: string): Promise<NavigateResponse> {
  await fetch(url, {
    mode: "no-cors",
    credentials: "omit",
    signal: AbortSignal.timeout(END_SESSION_TIMEOUT_MS),
  }).catch(() => undefined);
  return { url };
}

/** Browser-facing endpoints that move to the app origin under embedded sign-in. */
const EMBEDDED_ENDPOINTS = ["authorization_endpoint", "end_session_endpoint"] as const;

export class HerculesUserManager extends UserManager {
  /**
   * When the tenant's discovery document advertises embedded sign-in (the app
   * renders its own sign-in UI), point the authorize and end-session endpoints
   * at the app's own origin, where the platform serves its auth API and keeps
   * the embedded session cookie. The issuer, token, and JWKS endpoints are left
   * alone. Rewrites the cached metadata in place, so every later request uses
   * it; a no-op for any other provider.
   */
  async useEmbeddedEndpoints(): Promise<void> {
    const metadata = await this.metadataService.getMetadata();
    const embedded = readEmbeddedSignInMetadata(metadata as Record<string, unknown>);
    if (!embedded) return;
    const appOrigin = new URL(this.settings.redirect_uri).origin;
    for (const key of EMBEDDED_ENDPOINTS) {
      const value = metadata[key];
      if (typeof value !== "string" || new URL(value).origin === appOrigin) continue;
      metadata[key] = toEmbeddedEndpoint(new URL(value), appOrigin, embedded).toString();
    }
  }

  /**
   * Begin a redirect sign-in without navigating: store its state as
   * `signinRedirect` would and return the authorize URL. The embedded sign-in
   * client uses it to start a sign-in from any page.
   */
  async createAuthorizationUrl(options: { returnTo?: string; prompt?: string }): Promise<string> {
    await this.useEmbeddedEndpoints();
    const request = await this._client.createSigninRequest({
      request_type: "si:r",
      state: { returnTo: options.returnTo },
      ...(options.prompt ? { prompt: options.prompt } : {}),
    });
    return request.url;
  }

  protected override async _signinStart(
    args: CreateSigninRequestArgs,
    handle: IWindow,
  ): Promise<NavigateResponse> {
    await this.useEmbeddedEndpoints();
    return super._signinStart(args, handle);
  }

  // Transform after UserManager's revocation and single storage removal, inside its navigator action.
  protected override async _signoutStart(
    args: CreateSignoutRequestArgs = {},
    handle: IWindow,
  ): Promise<NavigateResponse> {
    await this.useEmbeddedEndpoints();
    if (args.request_type !== "so:r") return super._signoutStart(args, handle);

    return super._signoutStart(args, {
      close: () => handle.close(),
      navigate: (params) => {
        const url = logoutRedirectUrl(params.url, this.settings.client_id);
        if (this.settings.redirectTarget !== "top" && isFramed()) {
          return endSessionInBackground(url);
        }
        return handle.navigate({ ...params, url });
      },
    });
  }
}
