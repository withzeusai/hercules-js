import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthOptions } from "./auth-options";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

vi.mock("./session-context", () => ({
  getResolvedSession: vi.fn(),
  refreshResolvedSession: vi.fn(),
}));

vi.mock("./session-store", () => ({
  readSession: vi.fn(async () => ({ accessToken: "at", idToken: "id-token-jwt" })),
  clearSession: vi.fn(),
}));

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({
    serverMetadata: () => ({ end_session_endpoint: "https://issuer.example.com/end-session" }),
  })),
  None: vi.fn(() => undefined),
  buildEndSessionUrl: vi.fn(() => new URL("https://issuer.example.com/end-session?built=1")),
}));

import { getRequest } from "@tanstack/react-start/server";
import * as client from "openid-client";
import { getSignOutUrlBody } from "./action-bodies";
import { clearSession } from "./session-store";

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://issuer.example.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRequest).mockReturnValue(new Request("https://app.example.com/account"));
});

afterEach(() => {
  setAuthOptions({});
  vi.unstubAllEnvs();
});

/** The `post_logout_redirect_uri` handed to the provider on the last call. */
function sentPostLogoutRedirectUri(): string {
  const [, parameters] = vi.mocked(client.buildEndSessionUrl).mock.calls[0] as [
    unknown,
    Record<string, string>,
  ];
  return parameters.post_logout_redirect_uri;
}

describe("getSignOutUrlBody", () => {
  // A provider matches this against its registered post_logout_redirect_uris by
  // simple string comparison. Registrations spell an app's root as the bare
  // origin, so the trailing slash `new URL("/", origin)` produces is the
  // difference between coming back to the app and being stranded on the
  // provider's signed-out page.
  it("sends the bare origin by default", async () => {
    await getSignOutUrlBody();
    expect(sentPostLogoutRedirectUri()).toBe("https://app.example.com");
  });

  it("sends the bare origin for a root returnTo", async () => {
    await getSignOutUrlBody("/");
    expect(sentPostLogoutRedirectUri()).toBe("https://app.example.com");
  });

  it("sends the configured postLogoutRedirectUri when no returnTo is given", async () => {
    setAuthOptions({ postLogoutRedirectUri: "https://app.example.com/signed-out" });
    await getSignOutUrlBody();
    expect(sentPostLogoutRedirectUri()).toBe("https://app.example.com/signed-out");
  });

  it("passes the session's ID token as the logout hint", async () => {
    await getSignOutUrlBody();
    const [, parameters] = vi.mocked(client.buildEndSessionUrl).mock.calls[0] as [
      unknown,
      Record<string, string>,
    ];
    expect(parameters.id_token_hint).toBe("id-token-jwt");
  });

  it("returns the provider's end-session URL and clears the session", async () => {
    const { url } = await getSignOutUrlBody();
    expect(url).toBe("https://issuer.example.com/end-session?built=1");
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
