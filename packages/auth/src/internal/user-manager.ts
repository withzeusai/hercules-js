import { jwtDecode } from "jwt-decode";
import {
  UserManager,
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

export class HerculesUserManager extends UserManager {
  // Transform after UserManager's revocation and single storage removal, inside its navigator action.
  protected override _signoutStart(
    args: CreateSignoutRequestArgs = {},
    handle: IWindow,
  ): Promise<NavigateResponse> {
    if (args.request_type !== "so:r") return super._signoutStart(args, handle);

    return super._signoutStart(args, {
      close: () => handle.close(),
      navigate: (params) =>
        handle.navigate({
          ...params,
          url: logoutRedirectUrl(params.url, this.settings.client_id),
        }),
    });
  }
}
