import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the server actions the store calls. `vi.hoisted` so the spies exist
// before the hoisted `vi.mock` factory runs.
const { getAccessTokenAction, refreshAccessTokenAction, getIdTokenAction, refreshIdTokenAction } =
  vi.hoisted(() => ({
    getAccessTokenAction: vi.fn(),
    refreshAccessTokenAction: vi.fn(),
    getIdTokenAction: vi.fn(),
    refreshIdTokenAction: vi.fn(),
  }));
vi.mock("../server/actions", () => ({
  getAccessTokenAction,
  refreshAccessTokenAction,
  getIdTokenAction,
  refreshIdTokenAction,
}));

import { TokenStore } from "./tokenStore";

function jwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const freshJwt = () => jwt({ sub: "u1", iat: nowSeconds(), exp: nowSeconds() + 3600 });
const expiringJwt = () => jwt({ sub: "u1", iat: nowSeconds(), exp: nowSeconds() + 5 });

beforeEach(() => {
  // Fake only timers (not Date) so scheduled refreshes don't fire and JWT
  // expiry math stays real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getAccessTokenAction.mockReset();
  refreshAccessTokenAction.mockReset();
  getIdTokenAction.mockReset();
  refreshIdTokenAction.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("TokenStore", () => {
  it("parseToken returns null for an opaque token", () => {
    expect(new TokenStore().parseToken("opaque")).toBeNull();
  });

  it("returns a valid fetched token without refreshing", async () => {
    const token = freshJwt();
    getAccessTokenAction.mockResolvedValue(token);

    const store = new TokenStore();
    expect(await store.getTokenSilently()).toBe(token);
    expect(refreshAccessTokenAction).not.toHaveBeenCalled();
    expect(store.getSnapshot().token).toBe(token);
  });

  it("refreshes when the fetched token is already expiring", async () => {
    const refreshed = freshJwt();
    getAccessTokenAction.mockResolvedValue(expiringJwt());
    refreshAccessTokenAction.mockResolvedValue(refreshed);

    const store = new TokenStore();
    expect(await store.getTokenSilently()).toBe(refreshed);
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(1);
  });

  it("refresh() forces a refresh without the cheap GET", async () => {
    const refreshed = freshJwt();
    refreshAccessTokenAction.mockResolvedValue(refreshed);

    const store = new TokenStore();
    expect(await store.refreshToken()).toBe(refreshed);
    expect(getAccessTokenAction).not.toHaveBeenCalled();
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent refreshes (single-flight)", async () => {
    let resolve!: (token: string) => void;
    refreshAccessTokenAction.mockReturnValue(new Promise<string>((r) => (resolve = r)));

    const store = new TokenStore();
    const a = store.refreshToken();
    const b = store.refreshToken();
    resolve(freshJwt());

    const [ta, tb] = await Promise.all([a, b]);
    expect(ta).toBe(tb);
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(1);
  });

  it("records the error and clears loading when a refresh fails", async () => {
    refreshAccessTokenAction.mockRejectedValue(new Error("boom"));

    const store = new TokenStore();
    await expect(store.refreshToken()).rejects.toThrow("boom");
    expect(store.getSnapshot().error?.message).toBe("boom");
    expect(store.getSnapshot().loading).toBe(false);
  });

  it("does not schedule a 0 ms proactive refresh for short-lived tokens", async () => {
    // A token whose remaining life is within the expiry buffer would yield a
    // 0 ms delay and spin; the delay must be floored to MIN_REFRESH_DELAY (15s).
    refreshAccessTokenAction.mockResolvedValue(expiringJwt());

    const store = new TokenStore();
    await store.refreshToken();
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_000); // < 15s floor → no proactive refresh yet
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000); // now past the 15s floor
    expect(refreshAccessTokenAction).toHaveBeenCalledTimes(2);
  });

  it("uses the injected fetch/refresh actions (ID-token wiring)", async () => {
    const idToken = freshJwt();
    getIdTokenAction.mockResolvedValue(idToken);

    const store = new TokenStore(getIdTokenAction, refreshIdTokenAction);
    expect(await store.getTokenSilently()).toBe(idToken);
    expect(getIdTokenAction).toHaveBeenCalledTimes(1);
    // The access-token actions must not be touched by an ID-token store.
    expect(getAccessTokenAction).not.toHaveBeenCalled();
    expect(refreshAccessTokenAction).not.toHaveBeenCalled();
  });

  it("revalidates an opaque token instead of caching it forever", async () => {
    getAccessTokenAction.mockResolvedValue("opaque-token");

    const store = new TokenStore();
    // First read (no token): cheap GET returns a server-validated opaque token.
    expect(await store.getTokenSilently()).toBe("opaque-token");
    expect(getAccessTokenAction).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenAction).not.toHaveBeenCalled();

    // Second read: the cached opaque token must be revalidated via the server,
    // not returned blindly.
    expect(await store.getToken()).toBe("opaque-token");
    expect(getAccessTokenAction).toHaveBeenCalledTimes(2);
    expect(refreshAccessTokenAction).not.toHaveBeenCalled();
  });
});
