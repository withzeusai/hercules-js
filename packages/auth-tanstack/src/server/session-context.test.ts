import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkValue, sealSession, sessionChunkName, type SessionData } from "./session";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
  getCookies: vi.fn(() => ({})),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  None: vi.fn(() => undefined),
  refreshTokenGrant: vi.fn(),
  buildEndSessionUrl: vi.fn(),
}));

import { deleteCookie, getCookies, getRequest, setCookie } from "@tanstack/react-start/server";
import * as oidc from "openid-client";
import { getResolvedSession, refreshResolvedSession } from "./session-context";

const NOW = () => Math.floor(Date.now() / 1000);

function refreshedTokens(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "new-access",
    id_token: "new-id",
    refresh_token: "new-refresh",
    expires_in: 3600,
    claims: () => undefined,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
}

/** Point the mocked request context at a fresh Request carrying `session`. */
async function givenSession(session: SessionData): Promise<Request> {
  const request = new Request("https://app.example.com/route");
  vi.mocked(getRequest).mockReturnValue(request);
  const sealed = await sealSession(session);
  const cookies = Object.fromEntries(
    chunkValue(sealed).map((chunk, index) => [sessionChunkName(index), chunk]),
  );
  vi.mocked(getCookies).mockReturnValue(cookies);
  return request;
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

describe("getResolvedSession", () => {
  it("returns null when there is no session cookie", async () => {
    vi.mocked(getRequest).mockReturnValue(new Request("https://app.example.com/"));
    expect(await getResolvedSession()).toBeNull();
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it("returns an unexpired session without refreshing", async () => {
    await givenSession({ accessToken: "at", refreshToken: "rt", expiresAt: NOW() + 3600 });
    const session = await getResolvedSession();
    expect(session?.accessToken).toBe("at");
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it("auto-refreshes an expired session and re-seals it onto the response", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
    await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

    const session = await getResolvedSession();

    expect(session?.accessToken).toBe("new-access");
    expect(session?.refreshToken).toBe("new-refresh");
    expect(oidc.refreshTokenGrant).toHaveBeenCalledWith(expect.anything(), "rt");
    // The refreshed session was written back as a cookie.
    expect(setCookie).toHaveBeenCalledWith(
      sessionChunkName(0),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, maxAge: expect.any(Number) }),
    );
  });

  it("resolves (and refreshes) once per request", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
    await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

    const [first, second] = await Promise.all([getResolvedSession(), getResolvedSession()]);

    expect(first).toBe(second);
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it("returns the stale session when the refresh grant fails (maps to signed-out)", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(new Error("provider down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

    const session = await getResolvedSession();

    expect(session?.accessToken).toBe("stale");
    expect(setCookie).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns an expired session unrefreshed when there is no refresh token", async () => {
    await givenSession({ accessToken: "stale", expiresAt: NOW() - 10 });
    const session = await getResolvedSession();
    expect(session?.accessToken).toBe("stale");
    expect(oidc.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it("expires host-only chunks shadowing a domain-scoped refresh write", async () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_DOMAIN", ".example.com");
    try {
      vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
      await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

      await getResolvedSession();

      // The rewritten `.0` chunk is domain-scoped; the pre-migration host-only
      // `.0` from the request must get its own (domain-less) delete.
      expect(setCookie).toHaveBeenCalledWith(
        sessionChunkName(0),
        expect.any(String),
        expect.objectContaining({ domain: ".example.com" }),
      );
      expect(deleteCookie).toHaveBeenCalledWith(
        sessionChunkName(0),
        expect.not.objectContaining({ domain: expect.anything() }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("refreshResolvedSession", () => {
  it("refreshes and updates the per-request cache so later reads see the new tokens", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
    await givenSession({ accessToken: "at", refreshToken: "rt", expiresAt: NOW() + 3600 });

    const refreshed = await refreshResolvedSession();
    expect(refreshed?.accessToken).toBe("new-access");

    const resolved = await getResolvedSession();
    expect(resolved?.accessToken).toBe("new-access");
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it("uses the rotated refresh token for a second refresh in the same request", async () => {
    vi.mocked(oidc.refreshTokenGrant)
      .mockResolvedValueOnce(refreshedTokens({ refresh_token: "rotated" }))
      .mockResolvedValueOnce(refreshedTokens({ access_token: "newer-access" }));
    await givenSession({ accessToken: "at", refreshToken: "original", expiresAt: NOW() + 3600 });

    await refreshResolvedSession();
    await refreshResolvedSession();

    expect(oidc.refreshTokenGrant).toHaveBeenNthCalledWith(1, expect.anything(), "original");
    // Without the cache update this would re-present "original" — stale under
    // strict refresh-token rotation.
    expect(oidc.refreshTokenGrant).toHaveBeenNthCalledWith(2, expect.anything(), "rotated");
  });

  it("returns null when there is no session", async () => {
    vi.mocked(getRequest).mockReturnValue(new Request("https://app.example.com/"));
    expect(await refreshResolvedSession()).toBeNull();
  });

  it("performs a single grant when forcing a refresh of an already-expired session", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
    await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

    // Resolving inside the forced refresh already refreshes the expired
    // session; a second back-to-back grant would burn the rotated token.
    const refreshed = await refreshResolvedSession();

    expect(refreshed?.accessToken).toBe("new-access");
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it("reuses a session auto-refreshed earlier in the request instead of granting again", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(refreshedTokens());
    await givenSession({ accessToken: "stale", refreshToken: "rt", expiresAt: NOW() - 10 });

    const resolvedSession = await getResolvedSession();
    const refreshed = await refreshResolvedSession();

    expect(refreshed).toBe(resolvedSession);
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });
});
