import {
  useAuth as useOidcAuth,
  type AuthContextProps as OidcAuthContextProps,
} from "react-oidc-context";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import { useCallback, useMemo } from "react";

export interface SigninOptions {
  /**
   * In-app path to land on after sign-in (e.g. "/projects/42"). Round-tripped
   * through the OIDC `state` value and surfaced on `auth.user.state` as
   * `{ returnTo }` for the callback page to honor. Defaults to the current
   * URL (path + query + hash) so sign-in returns users to where they were.
   */
  returnTo?: string;
}

export interface AuthContextProps extends OidcAuthContextProps {
  signout: () => Promise<void>;
  signin: (options?: SigninOptions) => Promise<void>;
}

export function useAuth(): AuthContextProps {
  const { userManager } = useHerculesAuthProvider();
  const auth = useOidcAuth();

  const { signoutRedirect, removeUser, signinRedirect } = auth;
  const signout = useCallback(async () => {
    const endpoint = await userManager.metadataService.getEndSessionEndpoint();
    if (endpoint != null) {
      await signoutRedirect();
    } else {
      await removeUser();
    }
  }, [userManager, signoutRedirect, removeUser]);

  const signin = useCallback(
    async (options?: SigninOptions) => {
      const returnTo =
        options?.returnTo ??
        window.location.pathname + window.location.search + window.location.hash;
      await signinRedirect({ state: { returnTo } });
    },
    [signinRedirect],
  );

  return useMemo(() => {
    return {
      ...auth,
      signout,
      signin,
    } satisfies AuthContextProps;
  }, [auth, signout, signin]);
}
