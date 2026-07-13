import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "./session";

vi.mock("./session-context", () => ({
  getResolvedSession: vi.fn(),
  refreshResolvedSession: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
  getCookies: vi.fn(() => ({})),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

// `signOutBody` throws the redirect; return a marker object so the test can
// catch it and inspect the options (headers) it was built with.
vi.mock("@tanstack/react-router", () => ({
  redirect: vi.fn((options: unknown) => ({ isRedirect: true, options })),
}));

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  None: vi.fn(() => undefined),
  randomPKCECodeVerifier: vi.fn(() => "test-verifier"),
  calculatePKCECodeChallenge: vi.fn(async () => "test-challenge"),
  randomState: vi.fn(() => "test-state"),
  buildAuthorizationUrl: vi.fn(),
  buildEndSessionUrl: vi.fn(),
}));

import { getCookies, getRequest } from "@tanstack/react-start/server";
import { getResolvedSession } from "./session-context";
import { authorizationParameters, checkRecentAuthBody, signOutBody } from "./server-fn-bodies";

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

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://issuer.example.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
  process.env.HERCULES_AUTH_COOKIE_PASSWORD = "test-password-at-least-32-characters-long";
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCookies).mockReturnValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("signOutBody", () => {
  function signOutHeaders(thrown: unknown): string[] {
    const { options } = thrown as { options: { headers?: [string, string][] } };
    return (options.headers ?? []).map(([, header]) => header);
  }

  it("clears session cookies with the configured cookie domain", async () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_DOMAIN", ".example.com");
    vi.mocked(getRequest).mockReturnValue(new Request("https://app.example.com/account"));
    vi.mocked(getCookies).mockReturnValue({ "hercules_session.0": "sealed", other: "x" });

    const thrown = await signOutBody().then(
      () => expect.unreachable("signOutBody must throw a redirect"),
      (error: unknown) => error,
    );

    const headers = signOutHeaders(thrown);
    // Deletion must carry the same Domain the session was set with, or the
    // browser treats it as a different cookie and the session survives — and a
    // host-only cookie from before the domain was configured needs its own
    // host-only delete for the same reason.
    expect(headers).toHaveLength(2);
    expect(headers.every((h) => h.startsWith("hercules_session.0=;"))).toBe(true);
    expect(headers.every((h) => h.includes("Max-Age=0"))).toBe(true);
    expect(headers.filter((h) => h.includes("Domain=.example.com"))).toHaveLength(1);
  });

  it("clears session cookies without a Domain attribute when none is configured", async () => {
    vi.mocked(getRequest).mockReturnValue(new Request("https://app.example.com/account"));
    vi.mocked(getCookies).mockReturnValue({ "hercules_session.0": "sealed" });

    const thrown = await signOutBody().then(
      () => expect.unreachable("signOutBody must throw a redirect"),
      (error: unknown) => error,
    );

    const headers = signOutHeaders(thrown);
    expect(headers).toHaveLength(1);
    expect(headers[0]).not.toContain("Domain=");
  });
});
