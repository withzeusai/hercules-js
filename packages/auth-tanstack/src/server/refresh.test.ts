import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  None: vi.fn(() => undefined),
  refreshTokenGrant: vi.fn(),
}));

import * as oidc from "openid-client";
import { clearSharedRefreshGrants, performRefreshGrant } from "./refresh";

const session = { accessToken: "old-access", idToken: "old-id", refreshToken: "rt" };

function grantResult() {
  return {
    access_token: "new-access",
    refresh_token: "new-rt",
    expires_in: 3600,
    claims: () => undefined,
  } as unknown as Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
}

/** How openid-client reports a 429 with an OAuth error body (ResponseBodyError). */
function rateLimitedWithBody(retryAfter?: string): Error {
  const response = new Response(null, {
    status: 429,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
  const error = Object.assign(new Error("server responded with an error"), {
    error: "slow_down",
    status: 429,
  });
  Object.defineProperty(error, "response", { enumerable: false, value: response });
  return error;
}

/** How openid-client reports a 429 with any other body (ClientError). */
function rateLimitedWithoutBody(): Error {
  return new Error("unexpected HTTP response status code", {
    cause: new Response("Too Many Requests", { status: 429 }),
  });
}

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://issuer.example.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  clearSharedRefreshGrants();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("performRefreshGrant", () => {
  it.each([
    ["an OAuth error body", rateLimitedWithBody],
    ["any other body", rateLimitedWithoutBody],
  ])("retries once after a 429 with %s", async (_label, rateLimited) => {
    vi.mocked(oidc.refreshTokenGrant)
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(grantResult());

    const pending = performRefreshGrant(session);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-rt",
    });
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it("waits out Retry-After, capped at 5 s", async () => {
    vi.mocked(oidc.refreshTokenGrant)
      .mockRejectedValueOnce(rateLimitedWithBody("120"))
      .mockResolvedValueOnce(grantResult());

    const pending = performRefreshGrant(session);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it("gives up after the one retry", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(rateLimitedWithBody());

    const pending = performRefreshGrant(session);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeNull();
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures, which may have spent the refresh token", async () => {
    const invalidGrant = Object.assign(new Error("server responded with an error"), {
      error: "invalid_grant",
    });
    Object.defineProperty(invalidGrant, "response", {
      enumerable: false,
      value: new Response(null, { status: 400 }),
    });
    vi.mocked(oidc.refreshTokenGrant).mockRejectedValue(invalidGrant);

    await expect(performRefreshGrant(session)).resolves.toBeNull();
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });
});

describe("performRefreshGrant across concurrent requests", () => {
  function deferredGrant() {
    let resolve!: (value: ReturnType<typeof grantResult>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ReturnType<typeof grantResult>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("spends a refresh token once for requests that present it together", async () => {
    const grant = deferredGrant();
    vi.mocked(oidc.refreshTokenGrant).mockReturnValueOnce(grant.promise);

    const pending = Array.from({ length: 5 }, () => performRefreshGrant(session));
    grant.resolve(grantResult());

    const results = await Promise.all(pending);
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({ accessToken: "new-access", refreshToken: "new-rt" });
    }
  });

  it("answers a request that still presents the spent token with the same tokens", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValueOnce(grantResult());

    await performRefreshGrant(session);
    const late = await performRefreshGrant(session);

    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(late).toMatchObject({ accessToken: "new-access", refreshToken: "new-rt" });
  });

  it("runs a new grant once the reuse window has passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(grantResult());

    await performRefreshGrant(session);
    vi.setSystemTime(Date.now() + 10_001);
    await performRefreshGrant(session);

    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it("keeps different refresh tokens apart", async () => {
    vi.mocked(oidc.refreshTokenGrant).mockResolvedValue(grantResult());

    await Promise.all([
      performRefreshGrant(session),
      performRefreshGrant({ ...session, refreshToken: "another-rt" }),
    ]);

    expect(vi.mocked(oidc.refreshTokenGrant).mock.calls.map(([, token]) => token)).toEqual([
      "rt",
      "another-rt",
    ]);
  });

  it("shares a failure with the requests waiting on it, then tries again", async () => {
    const invalidGrant = Object.assign(new Error("server responded with an error"), {
      error: "invalid_grant",
    });
    const grant = deferredGrant();
    vi.mocked(oidc.refreshTokenGrant)
      .mockReturnValueOnce(grant.promise)
      .mockResolvedValueOnce(grantResult());

    const pending = [performRefreshGrant(session), performRefreshGrant(session)];
    grant.reject(invalidGrant);

    await expect(Promise.all(pending)).resolves.toEqual([null, null]);
    await expect(performRefreshGrant(session)).resolves.toMatchObject({
      accessToken: "new-access",
    });
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it("runs its own grant when the shared one never settles", async () => {
    // On Workers, a grant started by a request that was cancelled never settles.
    vi.mocked(oidc.refreshTokenGrant)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(grantResult());

    void performRefreshGrant(session);
    const waiting = performRefreshGrant(session);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(waiting).resolves.toMatchObject({ accessToken: "new-access" });
    expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });
});
