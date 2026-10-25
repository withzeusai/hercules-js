import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTokens } from "../server/types";

// The singletons at the bottom of tokenStore.ts default to the real server
// functions; stub the module so importing it doesn't pull in TanStack Start.
vi.mock("../server/actions", () => ({
  getSessionTokensAction: vi.fn(),
  refreshSessionTokensAction: vi.fn(),
}));

import { TokenSource, TokenStore } from "./tokenStore";

const START = Date.UTC(2026, 9, 24, 12, 0, 0);

/** Browser clock minus server clock, in ms. Tokens are minted on the server's clock. */
let skewMs = 0;
/** Total wall-clock jumps applied, so the monotonic clock ignores them. */
let wallJumpMs = 0;
const serverNowSeconds = () => Math.floor((Date.now() - skewMs) / 1000);

function jwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

/** A token minted on the server's clock `ageSeconds` ago. */
function token({ lifetime = 3600, ageSeconds = 0, kind = "at" } = {}): string {
  const iat = serverNowSeconds() - ageSeconds;
  return jwt({ sub: "u1", kind, iat, exp: iat + lifetime });
}

function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
  return {
    accessToken: token({ kind: "at" }),
    idToken: token({ kind: "id" }),
    serverTime: Date.now() - skewMs,
    ...overrides,
  };
}

/** Move the wall clock without real time passing (the OS or user changed it). */
function jumpWallClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
  wallJumpMs += ms;
}

let fetchTokens: ReturnType<typeof vi.fn<() => Promise<SessionTokens>>>;
let refreshTokens: ReturnType<typeof vi.fn<() => Promise<SessionTokens>>>;
let source: TokenSource;
let accessStore: TokenStore;
let idStore: TokenStore;

/** A store with a listener, as when a hook has it mounted. */
function mounted(store: TokenStore): () => void {
  return store.subscribe(() => {});
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
  skewMs = 0;
  wallJumpMs = 0;
  fetchTokens = vi.fn(async () => tokens());
  refreshTokens = vi.fn(async () => tokens());
  source = new TokenSource(fetchTokens, refreshTokens, () => Date.now() - wallJumpMs);
  accessStore = new TokenStore(source, (t) => t.accessToken);
  idStore = new TokenStore(source, (t) => t.idToken);
});

afterEach(() => {
  accessStore.reset();
  idStore.reset();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("TokenStore", () => {
  it("parseToken returns null for an opaque token", () => {
    expect(accessStore.parseToken("opaque")).toBeNull();
  });

  it("returns a valid fetched token without refreshing", async () => {
    const fetched = tokens();
    fetchTokens.mockResolvedValue(fetched);

    expect(await accessStore.getTokenSilently()).toBe(fetched.accessToken);
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(accessStore.getSnapshot().token).toBe(fetched.accessToken);
  });

  it("refreshes when the fetched token is already expiring", async () => {
    const refreshed = tokens();
    fetchTokens.mockResolvedValue(tokens({ accessToken: token({ lifetime: 5 }) }));
    refreshTokens.mockResolvedValue(refreshed);

    expect(await accessStore.getTokenSilently()).toBe(refreshed.accessToken);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("refresh() forces a refresh without the cheap read", async () => {
    const refreshed = tokens();
    refreshTokens.mockResolvedValue(refreshed);

    expect(await accessStore.refreshToken()).toBe(refreshed.accessToken);
    expect(fetchTokens).not.toHaveBeenCalled();
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent refreshes (single-flight)", async () => {
    let resolve!: (value: SessionTokens) => void;
    refreshTokens.mockReturnValue(new Promise((r) => (resolve = r)));

    const a = accessStore.refreshToken();
    const b = accessStore.refreshToken();
    resolve(tokens());

    const [ta, tb] = await Promise.all([a, b]);
    expect(ta).toBe(tb);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("records the error and clears loading when a refresh fails", async () => {
    refreshTokens.mockRejectedValue(new Error("boom"));

    await expect(accessStore.refreshToken()).rejects.toThrow("boom");
    expect(accessStore.getSnapshot().error?.message).toBe("boom");
    expect(accessStore.getSnapshot().loading).toBe(false);
  });

  it("does not schedule a 0 ms proactive refresh for short-lived tokens", async () => {
    // A token whose remaining life is within the expiry buffer would yield a
    // 0 ms delay and spin; the delay must be floored to MIN_REFRESH_DELAY (15s).
    mounted(accessStore);
    refreshTokens.mockImplementation(async () => tokens({ accessToken: token({ lifetime: 5 }) }));

    await accessStore.refreshToken();
    expect(refreshTokens).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_000); // < 15s floor → no proactive refresh yet
    expect(refreshTokens).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000); // now past the 15s floor
    expect(refreshTokens).toHaveBeenCalledTimes(2);
  });

  it("selects its own token from the shared result (ID-token wiring)", async () => {
    const fetched = tokens();
    fetchTokens.mockResolvedValue(fetched);

    expect(await idStore.getTokenSilently()).toBe(fetched.idToken);
    expect(idStore.getSnapshot().token).toBe(fetched.idToken);
  });

  it("revalidates an opaque token instead of caching it forever", async () => {
    fetchTokens.mockResolvedValue(tokens({ accessToken: "opaque-token" }));

    // First read (no token): the cheap read returns a server-validated opaque token.
    expect(await accessStore.getTokenSilently()).toBe("opaque-token");
    expect(fetchTokens).toHaveBeenCalledTimes(1);
    expect(refreshTokens).not.toHaveBeenCalled();

    // Second read: the cached opaque token must be revalidated via the server,
    // not returned blindly.
    expect(await accessStore.getToken()).toBe("opaque-token");
    expect(fetchTokens).toHaveBeenCalledTimes(2);
    expect(refreshTokens).not.toHaveBeenCalled();
  });
});

describe("shared refresh across the access- and ID-token stores", () => {
  it("runs one refresh when both stores refresh at once", async () => {
    const [access, id] = await Promise.all([accessStore.refreshToken(), idStore.refreshToken()]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(access).toBe(accessStore.getSnapshot().token);
    expect(id).toBe(idStore.getSnapshot().token);
  });

  it("hands one store's refresh to the other", async () => {
    const refreshed = tokens();
    refreshTokens.mockResolvedValue(refreshed);

    await accessStore.refreshToken();

    expect(idStore.getSnapshot().token).toBe(refreshed.idToken);
  });

  it("shares one initial read between both stores", async () => {
    await Promise.all([accessStore.getTokenSilently(), idStore.getTokenSilently()]);
    expect(fetchTokens).toHaveBeenCalledTimes(1);
  });

  it("refreshes once per cycle when both tokens expire together", async () => {
    mounted(accessStore);
    mounted(idStore);
    await Promise.all([accessStore.getTokenSilently(), idStore.getTokenSilently()]);

    // Both timers fire at expiry − 60 s; one grant serves both. Three cycles:
    // t ≈ 3540 s, 7080 s, 10620 s.
    await vi.advanceTimersByTimeAsync(3 * 3540_000 + 1_000);
    expect(refreshTokens).toHaveBeenCalledTimes(3);
  });

  it("joins a read to a refresh already in flight", async () => {
    let resolve!: (value: SessionTokens) => void;
    refreshTokens.mockReturnValue(new Promise((r) => (resolve = r)));

    const refreshing = accessStore.refreshToken();
    const reading = idStore.getTokenSilently();
    resolve(tokens());
    await Promise.all([refreshing, reading]);

    expect(fetchTokens).not.toHaveBeenCalled();
  });
});

describe("timers follow listeners", () => {
  it("schedules nothing while no hook is mounted", async () => {
    await accessStore.getTokenSilently();
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("schedules the refresh again when a hook remounts with a fresh token", async () => {
    const unmount = mounted(accessStore);
    await accessStore.getTokenSilently();
    unmount(); // cancels the timer

    await vi.advanceTimersByTimeAsync(60_000);
    mounted(accessStore);
    await accessStore.getTokenSilently(); // fresh: no request, but re-queues the timer
    expect(refreshTokens).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3540_000);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });
});

describe("clock skew", () => {
  it.each([
    ["2 h ahead", 2 * 3600],
    ["2 min ahead", 120],
    ["2 min behind", -120],
    ["2 h behind", -2 * 3600],
  ])("browser clock %s: judges expiry on the server's clock", async (_label, skewSeconds) => {
    skewMs = skewSeconds * 1000;
    mounted(accessStore);

    await accessStore.getTokenSilently();
    expect(fetchTokens).toHaveBeenCalledTimes(1);
    expect(accessStore.parseToken(accessStore.getSnapshot().token)).toMatchObject({
      isExpiring: false,
      timeUntilExpiry: 3600,
    });

    // No refresh until expiry − 60 s on the server's clock, then one per cycle.
    await vi.advanceTimersByTimeAsync(3539_000);
    expect(refreshTokens).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3540_000);
    expect(refreshTokens).toHaveBeenCalledTimes(2);
  });

  it("measures skew from the first read, even for a token minted long ago", async () => {
    // Browser 10 min behind; the session's token was minted 50 min ago and has
    // 10 min left. On the browser's own clock it would look like 20 min left.
    skewMs = -600_000;
    fetchTokens.mockResolvedValue(tokens({ accessToken: token({ ageSeconds: 3000 }) }));

    await accessStore.getTokenSilently();
    expect(accessStore.parseToken(accessStore.getSnapshot().token)?.timeUntilExpiry).toBe(600);
  });

  it("refreshes on read once a behind clock's token is near expiry (the Convex case)", async () => {
    // Convex refetches 10 s before expiry; with the browser 2 min behind, the
    // store must still see the token as expiring and hand back a new one.
    skewMs = -120_000;
    const initial = tokens();
    fetchTokens.mockResolvedValue(initial);
    await idStore.getTokenSilently();

    await vi.advanceTimersByTimeAsync(3590_000);
    const fresh = await idStore.getToken();

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(fresh).not.toBe(initial.idToken);
  });

  it("re-measures with a cheap read when the wall clock jumps mid-session", async () => {
    // Browser 1 h ahead, then the OS corrects it. With the stale offset the
    // token would look an hour fresher than it is.
    skewMs = 3600_000;
    await accessStore.getTokenSilently();
    await vi.advanceTimersByTimeAsync(3000_000); // 10 min left on the server's clock

    jumpWallClock(-3600_000);
    skewMs = 0;
    fetchTokens.mockResolvedValue(tokens({ accessToken: accessStore.getSnapshot().token }));

    await accessStore.getToken();
    expect(fetchTokens).toHaveBeenCalledTimes(2);
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(accessStore.parseToken(accessStore.getSnapshot().token)?.timeUntilExpiry).toBe(600);
  });

  it("trusts the offset while the clock runs normally", async () => {
    skewMs = 3600_000;
    await accessStore.getTokenSilently();
    await vi.advanceTimersByTimeAsync(600_000);

    await accessStore.getToken();
    expect(fetchTokens).toHaveBeenCalledTimes(1);
  });
});
