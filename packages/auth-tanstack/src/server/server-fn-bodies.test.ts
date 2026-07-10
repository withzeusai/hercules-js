import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "./session";

vi.mock("./session-context", () => ({
  getResolvedSession: vi.fn(),
  refreshResolvedSession: vi.fn(),
}));

import { getResolvedSession } from "./session-context";
import { authorizationParameters, checkRecentAuthBody } from "./server-fn-bodies";

const FLOW = { redirectUri: "https://app.example.com/auth/callback", state: "s", codeChallenge: "c" };

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (payload: object) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;

function sessionWithAuthTime(authTime: unknown): SessionData {
  return {
    accessToken: "opaque-access-token",
    idToken: fakeJwt({ sub: "user-1", auth_time: authTime }),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authorizationParameters", () => {
  it("builds the base PKCE parameters with the default scope", () => {
    expect(authorizationParameters({}, FLOW)).toEqual({
      redirect_uri: FLOW.redirectUri,
      scope: "openid profile email",
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
  });

  it("maps screenHint, maxAge, and loginHint onto their OIDC parameters", () => {
    const parameters = authorizationParameters(
      { screenHint: "sign-up", maxAge: 300, loginHint: "user@example.com", scope: "openid" },
      FLOW,
    );
    expect(parameters).toMatchObject({
      screen_hint: "sign-up",
      max_age: "300",
      login_hint: "user@example.com",
      scope: "openid",
    });
  });

  it("forwards max_age=0 (always force reauthentication)", () => {
    expect(authorizationParameters({ maxAge: 0 }, FLOW).max_age).toBe("0");
  });

  it("omits max_age for negative or absent values", () => {
    expect(authorizationParameters({ maxAge: -1 }, FLOW).max_age).toBeUndefined();
    expect(authorizationParameters({}, FLOW).max_age).toBeUndefined();
  });
});

describe("checkRecentAuthBody", () => {
  it("reports fresh when auth_time is within maxAge", async () => {
    const authTime = Math.floor(Date.now() / 1000) - 60;
    vi.mocked(getResolvedSession).mockResolvedValue(sessionWithAuthTime(authTime));

    const result = await checkRecentAuthBody({ maxAge: 300 });

    expect(result.isStale).toBe(false);
    expect(result.authenticatedAt).toEqual(new Date(authTime * 1000));
  });

  it("reports stale when auth_time is older than maxAge", async () => {
    const authTime = Math.floor(Date.now() / 1000) - 600;
    vi.mocked(getResolvedSession).mockResolvedValue(sessionWithAuthTime(authTime));

    expect((await checkRecentAuthBody({ maxAge: 300 })).isStale).toBe(true);
  });

  it("fails closed without a session", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue(null);
    expect(await checkRecentAuthBody({ maxAge: 300 })).toEqual({
      authenticatedAt: null,
      isStale: true,
    });
  });

  it("fails closed for an expired (unrefreshable) session", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue({
      accessToken: "at",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    expect((await checkRecentAuthBody({ maxAge: 300 })).isStale).toBe(true);
  });

  it("fails closed when the session has no auth_time claim", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue(sessionWithAuthTime(undefined));
    expect(await checkRecentAuthBody({ maxAge: 300 })).toEqual({
      authenticatedAt: null,
      isStale: true,
    });
  });
});
