import { InMemoryWebStorage, WebStorageStateStore } from "oidc-client-ts";
import { describe, expect, it } from "vitest";
import { HerculesUserManager } from "./user-manager";

const AUTHORITY = "https://tenant.hercules-auth.com";
const APP = "https://theirapp.com";

function manager(embedded: boolean) {
  const stateStore = new WebStorageStateStore({ store: new InMemoryWebStorage() });
  const userManager = new HerculesUserManager({
    authority: AUTHORITY,
    client_id: "client",
    redirect_uri: `${APP}/auth/callback`,
    stateStore,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    metadata: {
      issuer: AUTHORITY,
      authorization_endpoint: `${AUTHORITY}/api/auth/oauth2/authorize`,
      end_session_endpoint: `${AUTHORITY}/api/auth/oauth2/end-session`,
      token_endpoint: `${AUTHORITY}/api/auth/oauth2/token`,
      ...(embedded
        ? {
            hercules_embedded_sign_in: {
              auth_base_path: "/_hercules/auth",
              sign_in_path: "/login",
            },
          }
        : {}),
    },
  });
  return { userManager, stateStore };
}

describe("HerculesUserManager embedded sign-in", () => {
  it("moves authorize and end-session to the app origin, leaving the token endpoint", async () => {
    const { userManager } = manager(true);

    await userManager.useEmbeddedEndpoints();

    expect(await userManager.metadataService.getAuthorizationEndpoint()).toBe(
      `${APP}/_hercules/auth/oauth2/authorize`,
    );
    expect(await userManager.metadataService.getEndSessionEndpoint()).toBe(
      `${APP}/_hercules/auth/oauth2/end-session`,
    );
    expect(await userManager.metadataService.getTokenEndpoint()).toBe(
      `${AUTHORITY}/api/auth/oauth2/token`,
    );
  });

  it("leaves a hosted tenant's endpoints alone", async () => {
    const { userManager } = manager(false);

    await userManager.useEmbeddedEndpoints();

    expect(await userManager.metadataService.getAuthorizationEndpoint()).toBe(
      `${AUTHORITY}/api/auth/oauth2/authorize`,
    );
  });

  it("starts a sign-in without navigating, storing state for the callback", async () => {
    const { userManager, stateStore } = manager(true);

    const url = new URL(
      await userManager.createAuthorizationUrl({ returnTo: "/pricing", prompt: "create" }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(`${APP}/_hercules/auth/oauth2/authorize`);
    expect(url.searchParams.get("prompt")).toBe("create");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const stored = await stateStore.get(url.searchParams.get("state")!);
    expect(JSON.parse(stored!).data).toEqual({ returnTo: "/pricing" });
  });
});
