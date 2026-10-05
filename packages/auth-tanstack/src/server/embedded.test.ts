import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodePkceState, pkceCookieName } from "./config";
import { handleCallbackInternal, handleSignInInternal } from "./route-bodies";
import { authorizationParameters } from "./server-fn-bodies";

// A Hercules tenant whose app renders its own sign-in UI advertises it in
// discovery; the browser-facing endpoints then move to the app origin.
vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({
    serverMetadata: () => ({
      issuer: "https://tenant.hercules-auth.com",
      authorization_endpoint: "https://tenant.hercules-auth.com/api/auth/oauth2/authorize",
      end_session_endpoint: "https://tenant.hercules-auth.com/api/auth/oauth2/end-session",
      hercules_embedded_sign_in: {
        auth_base_path: "/_hercules/auth",
        sign_in_path: "/login",
        sign_up_path: "/login",
      },
    }),
  })),
  None: vi.fn(() => undefined),
  randomPKCECodeVerifier: vi.fn(() => "test-verifier"),
  calculatePKCECodeChallenge: vi.fn(async () => "test-challenge"),
  randomState: vi.fn(() => "fresh-state"),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://tenant.hercules-auth.com/api/auth/oauth2/authorize");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }),
  buildEndSessionUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://tenant.hercules-auth.com/api/auth/oauth2/end-session");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }),
  authorizationCodeGrant: vi.fn(),
  refreshTokenGrant: vi.fn(),
}));

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://tenant.hercules-auth.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
  process.env.HERCULES_AUTH_COOKIE_PASSWORD = "test-password-at-least-32-characters-long";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("embedded sign-in", () => {
  it("sends sign-in to the authorize endpoint on the app's own origin", async () => {
    const response = await handleSignInInternal(new Request("https://theirapp.com/auth/sign-in"));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://theirapp.com");
    expect(location.pathname).toBe("/_hercules/auth/oauth2/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://theirapp.com/auth/callback");
    expect(location.searchParams.get("state")).toBe("fresh-state");
  });

  it("returns a declined callback to the app's sign-in page with the reason", async () => {
    const state = "abc123";
    const cookie = `${pkceCookieName(state)}=${encodePkceState({ verifier: "v" })}`;
    const response = await handleCallbackInternal(
      new Request(`https://theirapp.com/auth/callback?error=login_required&state=${state}`, {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://theirapp.com/login?error=login_required",
    );
    expect(response.headers.get("set-cookie")).toContain(`${pkceCookieName(state)}=;`);
  });

  it("ends the session on the app's own origin", async () => {
    const { resolveLogoutLocation } = await import("./refresh");

    const location = new URL(await resolveLogoutLocation("https://theirapp.com/", "id-token"));

    expect(location.origin).toBe("https://theirapp.com");
    expect(location.pathname).toBe("/_hercules/auth/oauth2/end-session");
    expect(location.searchParams.get("id_token_hint")).toBe("id-token");
  });

  it("forwards prompt", () => {
    expect(
      authorizationParameters(
        { prompt: "create" },
        { redirectUri: "https://theirapp.com/auth/callback", state: "s", codeChallenge: "c" },
      ).prompt,
    ).toBe("create");
  });
});
