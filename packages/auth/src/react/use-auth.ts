import {
  useAuth as useOidcAuth,
  type AuthContextProps as OidcAuthContextProps,
} from "react-oidc-context";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import { useCallback, useMemo } from "react";

export interface AuthContextProps extends OidcAuthContextProps {
  signout: () => Promise<void>;
}

export function useAuth(): AuthContextProps {
  const { userManager } = useHerculesAuthProvider();
  const auth = useOidcAuth();

  const { signoutRedirect, removeUser } = auth;
  const signout = useCallback(async () => {
    const endpoint = await userManager.metadataService.getEndSessionEndpoint();
    if (endpoint != null) {
      await signoutRedirect();
    } else {
      await removeUser();
    }
  }, [userManager, signoutRedirect, removeUser]);

  return useMemo(() => {
    return {
      ...auth,
      signout,
    } satisfies AuthContextProps;
  }, [auth, signout]);
}
