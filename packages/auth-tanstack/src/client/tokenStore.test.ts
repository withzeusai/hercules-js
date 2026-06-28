import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the server actions the store calls. `vi.hoisted` so the spies exist
// before the hoisted `vi.mock` factory runs.
const { getAccessTokenAction, refreshAccessTokenAction } = vi.hoisted(() => ({
  getAccessTokenAction: vi.fn(),
  refreshAccessTokenAction: vi.fn(),
}));
vi.mock("../server/actions", () => ({ getAccessTokenAction, refreshAccessTokenAction }));

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
    expect(await store.getAccessTokenSilently()).toBe(token);
    expect(refreshAccessTokenAction).not.toHaveBeenCalled();
    expect(store.getSnapshot().token).toBe(token);
  });

  it("refreshes when the fetched token is already expiring", async () => {
    const refreshed = freshJwt();
    getAccessTokenAction.mockResolvedValue(expiringJwt());
    refreshAccessTokenAction.mockResolvedValue(refreshed);

    const store = new TokenStore();
    expect(await store.getAccessTokenSilently()).toBe(refreshed);
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
});
