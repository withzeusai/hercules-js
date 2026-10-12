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
import {
  getSignOutUrlBody,
  refreshAccessTokenBody,
  refreshAuthBody,
  refreshIdTokenBody,
} from "./action-bodies";
import type { SessionData } from "./session";
import { getResolvedSession, refreshResolvedSession } from "./session-context";
import { clearSession, readSession } from "./session-store";

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (payload: object) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;

/** A session whose tokens are still valid but that carries no refresh token. */
function unrefreshableSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    accessToken: fakeJwt({ sub: "user-1", role: "admin" }),
    idToken: fakeJwt({ sub: "user-1", email: "user@example.com" }),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

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

  // Nothing to end, and a hintless end-session request only earns the OP's
  // confirmation page, so a lapsed session must not be sent to the provider.
  it("goes straight to the post-logout target when there is no session", async () => {
    vi.mocked(readSession).mockResolvedValueOnce(undefined);

    const { url } = await getSignOutUrlBody();

    expect(url).toBe("https://app.example.com");
    expect(client.buildEndSessionUrl).not.toHaveBeenCalled();
  });

  it("still clears cookies when there is no session", async () => {
    vi.mocked(readSession).mockResolvedValueOnce(undefined);

    await getSignOutUrlBody();

    expect(clearSession).toHaveBeenCalledOnce();
  });

  it("honors returnTo when there is no session", async () => {
    vi.mocked(readSession).mockResolvedValueOnce(undefined);

    const { url } = await getSignOutUrlBody("/bye");

    expect(url).toBe("https://app.example.com/bye");
  });

  it("returns the provider's end-session URL and clears the session", async () => {
    const { url } = await getSignOutUrlBody();
    expect(url).toBe("https://issuer.example.com/end-session?built=1");
    expect(clearSession).toHaveBeenCalledOnce();
  });
});

// The provider issues a refresh token only when `offline_access` was granted,
// and a grant can fail transiently. Neither means the user is signed out — the
// current tokens may have hours left — but every caller treats an empty refresh
// result as exactly that. Convex is the sharp edge: it forces a refresh right
// after confirming the cached token, and an empty answer there latches the
// client unauthenticated for the rest of the page.
describe("refresh actions without a refresh token", () => {
  beforeEach(() => {
    vi.mocked(refreshResolvedSession).mockResolvedValue(null);
  });

  it("refreshIdTokenBody returns the current ID token when no refresh is possible", async () => {
    const session = unrefreshableSession();
    vi.mocked(getResolvedSession).mockResolvedValue(session);

    await expect(refreshIdTokenBody()).resolves.toBe(session.idToken);
  });

  it("refreshAccessTokenBody returns the current access token when no refresh is possible", async () => {
    const session = unrefreshableSession();
    vi.mocked(getResolvedSession).mockResolvedValue(session);

    await expect(refreshAccessTokenBody()).resolves.toBe(session.accessToken);
  });

  it("refreshAuthBody keeps the user signed in when no refresh is possible", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue(unrefreshableSession());

    const auth = await refreshAuthBody();
    expect(auth.user?.id).toBe("user-1");
    expect(auth).not.toHaveProperty("accessToken");
  });

  it("still prefers the refreshed session when a grant did run", async () => {
    const refreshed = unrefreshableSession({ idToken: fakeJwt({ sub: "user-1", fresh: true }) });
    vi.mocked(refreshResolvedSession).mockResolvedValue(refreshed);
    vi.mocked(getResolvedSession).mockResolvedValue(unrefreshableSession());

    await expect(refreshIdTokenBody()).resolves.toBe(refreshed.idToken);
    expect(getResolvedSession).not.toHaveBeenCalled();
  });

  it("returns nothing once the current session has expired", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue(
      unrefreshableSession({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    );

    await expect(refreshIdTokenBody()).resolves.toBeUndefined();
    await expect(refreshAccessTokenBody()).resolves.toBeUndefined();
    await expect(refreshAuthBody()).resolves.toEqual({ user: null });
  });

  it("returns nothing when there is no session at all", async () => {
    vi.mocked(getResolvedSession).mockResolvedValue(null);

    await expect(refreshIdTokenBody()).resolves.toBeUndefined();
    await expect(refreshAuthBody()).resolves.toEqual({ user: null });
  });
});
