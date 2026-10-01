import type { UserManager } from "oidc-client-ts";
import type { AuthContextProps } from "react-oidc-context";

function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export async function signOut(
  userManager: UserManager,
  { signoutRedirect, removeUser }: Pick<AuthContextProps, "signoutRedirect" | "removeUser">,
): Promise<void> {
  const endpoint = await userManager.metadataService.getEndSessionEndpoint();
  if (endpoint == null) {
    await removeUser();
    return;
  }
  if (!isFramed()) {
    await signoutRedirect();
    return;
  }
  if (userManager.settings.revokeTokensOnSignout) {
    await userManager.revokeTokens();
  }
  await removeUser();
}
