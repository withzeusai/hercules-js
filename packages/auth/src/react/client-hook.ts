import { useCallback, useMemo } from "react";
import { useUserManager } from "./hercules-auth-provider";
import { createAuthClient, type components } from "../client";
import { type IdTokenClaims, User } from "oidc-client-ts";

function decodeIdToken(idToken: string): IdTokenClaims {
  const payload = idToken.split(".")[1];
  if (payload == null) throw new Error("Invalid id token");
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

function createUser(
  oauthTokenResponse: components["schemas"]["OAuthTokenResponse"],
) {
  return new User({
    access_token: oauthTokenResponse.access_token,
    refresh_token: oauthTokenResponse.refresh_token,
    id_token: oauthTokenResponse.id_token,
    profile: decodeIdToken(oauthTokenResponse.id_token),
    token_type: oauthTokenResponse.token_type,
    expires_at: oauthTokenResponse.expires_at,
  });
}

export function useClient({ baseUrl }: { baseUrl: string }) {
  const userManager = useUserManager();
  const client = useMemo(
    () =>
      createAuthClient({
        baseUrl: baseUrl ?? "https://test.auth.onhercules.app",
      }),
    [baseUrl],
  );

  const signinEmail = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      const res = await client.POST("/api/signin/email", {
        body: { email, password },
      });
      if (res.error != null) throw new Error(res.error.error);

      const user = createUser(res.data);
      await userManager.storeUser(user);
      userManager.events.load(user);
    },
    [client],
  );

  const signupEmail = useCallback(
    async ({
      email,
      password,
      name,
    }: {
      email: string;
      password: string;
      name: string;
    }) => {
      const res = await client.POST("/api/signup/email", {
        body: {
          email,
          password,
          name,
        },
      });
      if (res.error != null) throw new Error(res.error.error);

      const user = createUser(res.data);
      await userManager.storeUser(user);
      userManager.events.load(user);
    },
    [client],
  );

  return { signinEmail, signupEmail };
}
