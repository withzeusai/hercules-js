import {
  useAuth as useOidcAuth,
  type AuthContextProps,
} from "react-oidc-context";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import { useCallback, useMemo } from "react";

interface UseHerculesAuthResult extends AuthContextProps {
  signout: () => Promise<void>;
}
export function useAuth(): UseHerculesAuthResult {
  const { userManager } = useHerculesAuthProvider();
  const auth = useOidcAuth();

  const { signoutRedirect, removeUser } = auth;
  const signout = useCallback(async () => {
    const endpoint = await userManager.metadataService.getEndSessionEndpoint();
    if (endpoint != null) {
      await signoutRedirect();
    } else {
      removeUser();
    }
  }, [userManager, signoutRedirect, removeUser]);

  return useMemo(() => {
    return {
      ...auth,
      signout,
    } satisfies UseHerculesAuthResult;
  }, [auth, signout]);
}
