import {
  useAuth as useOidcAuth,
  type AuthContextProps as OidcAuthContextProps,
} from "react-oidc-context";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import { useCallback, useMemo } from "react";
import { reportAuthDiagnostic, startAuthAttempt } from "./diagnostics";
import type { SigninRedirectArgs } from "oidc-client-ts";

export interface AuthContextProps extends OidcAuthContextProps {
  signout: () => Promise<void>;
  signin: () => Promise<void>;
}

export function useAuth(): AuthContextProps {
  const { userManager, authority, clientId, redirectUri, diagnostics } =
    useHerculesAuthProvider();
  const auth = useOidcAuth();

  const { signoutRedirect, removeUser, signinRedirect: rawSigninRedirect } =
    auth;

  const signout = useCallback(async () => {
    const endpoint = await userManager.metadataService.getEndSessionEndpoint();
    if (endpoint != null) {
      await signoutRedirect();
    } else {
      await removeUser();
    }
  }, [userManager, signoutRedirect, removeUser]);

  const signinRedirect = useCallback(
    async (args?: SigninRedirectArgs): Promise<void> => {
      // Start a fresh attempt id before kicking off the redirect so the
      // callback page can correlate failures back to this start.
      startAuthAttempt();
      try {
        await rawSigninRedirect(args);
      } catch (err) {
        // Best-effort: try to surface the issuer the SDK believed it was
        // talking to. metadataService caches the doc; this is cheap on hit
        // and a no-op on miss.
        let metadataIssuer: string | undefined;
        let tokenEndpoint: string | undefined;
        try {
          metadataIssuer = await userManager.metadataService.getIssuer();
        } catch {
          // metadata fetch itself failed — that's the most likely cause of
          // this branch. The error itself is already captured below.
        }
        try {
          tokenEndpoint = await userManager.metadataService.getTokenEndpoint();
        } catch {
          // ignore
        }

        reportAuthDiagnostic(diagnostics, {
          phase: "signin-redirect-failed",
          error: err,
          authority,
          clientId,
          redirectUri,
          metadataIssuer,
          tokenEndpoint,
        });
        throw err;
      }
    },
    [rawSigninRedirect, userManager, diagnostics, authority, clientId, redirectUri],
  );

  const signin = useCallback(async () => {
    await signinRedirect();
  }, [signinRedirect]);

  return useMemo(() => {
    return {
      ...auth,
      signinRedirect,
      signout,
      signin,
    } satisfies AuthContextProps;
  }, [auth, signinRedirect, signout, signin]);
}
