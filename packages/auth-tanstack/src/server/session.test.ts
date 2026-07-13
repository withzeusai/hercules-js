import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import {
  SESSION_COOKIE,
  clearSessionCookies,
  deserializeSessionCookies,
  isSessionExpired,
  sealSession,
  serializeSessionCookies,
  sessionChunkName,
  sessionCookieBase,
  unsealSession,
  type SessionData,
} from "./session";

// The key is derived lazily from this on first seal/unseal.
beforeAll(() => {
  process.env.HERCULES_AUTH_COOKIE_PASSWORD = "test-password-at-least-32-characters-long";
});

/** Extract `name -> value` from the `name=value; attrs` form of a Set-Cookie. */
function cookieFromHeader(header: string): [string, string] {
  const pair = header.split(";")[0]!;
  const eq = pair.indexOf("=");
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

function cookieRecord(headers: string[]): Record<string, string> {
  return Object.fromEntries(headers.map(cookieFromHeader));
}

describe("sealSession / unsealSession", () => {
  it("round-trips a session", async () => {
    const session: SessionData = {
      accessToken: "access",
      idToken: "id",
      refreshToken: "refresh",
      expiresAt: 1234567890,
    };
    const sealed = await sealSession(session);
    expect(await unsealSession(sealed)).toEqual(session);
  });

  it("produces a versioned, cookie-safe value", async () => {
    const sealed = await sealSession({ accessToken: "a" });
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toMatch(/[;,\s]/);
  });

  it("uses a fresh IV per seal (ciphertext differs)", async () => {
    const a = await sealSession({ accessToken: "a" });
    const b = await sealSession({ accessToken: "a" });
    expect(a).not.toBe(b);
  });

  it("returns null for a tampered value", async () => {
    const sealed = await sealSession({ accessToken: "a" });
    expect(await unsealSession(`${sealed}tampered`)).toBeNull();
  });

  it("returns null for a structurally invalid value", async () => {
    expect(await unsealSession("not-a-sealed-value")).toBeNull();
    expect(await unsealSession("v2.aa.bb")).toBeNull();
  });
});

describe("session cookie chunking", () => {
  it("round-trips a value spanning multiple chunks", () => {
    const value = "x".repeat(7000); // > MAX_CHUNK_LENGTH (3072) -> 3 chunks
    const headers = serializeSessionCookies(value, { path: "/" });
    const names = headers.map((h) => cookieFromHeader(h)[0]);
    expect(names).toEqual([`${SESSION_COOKIE}.0`, `${SESSION_COOKIE}.1`, `${SESSION_COOKIE}.2`]);
    expect(deserializeSessionCookies(cookieRecord(headers))).toBe(value);
  });

  it("fits a small value in a single chunk", () => {
    const headers = serializeSessionCookies("small", { path: "/" });
    expect(headers).toHaveLength(1);
    expect(cookieFromHeader(headers[0]!)[0]).toBe(`${SESSION_COOKIE}.0`);
  });

  it("expires stale chunks left by a longer prior session", () => {
    const headers = serializeSessionCookies("small", { path: "/" }, [
      `${SESSION_COOKIE}.0`,
      `${SESSION_COOKIE}.1`,
      `${SESSION_COOKIE}.2`,
    ]);
    const expired = headers
      .filter((h) => h.includes("Max-Age=0"))
      .map((h) => cookieFromHeader(h)[0]);
    expect(expired).toEqual([`${SESSION_COOKIE}.1`, `${SESSION_COOKIE}.2`]);
  });

  it("expires a legacy single cookie when rewriting as chunks", () => {
    const headers = serializeSessionCookies("small", { path: "/" }, [SESSION_COOKIE]);
    expect(
      headers.some((h) => h.startsWith(`${SESSION_COOKIE}=;`) && h.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("reads a legacy single cookie", () => {
    expect(deserializeSessionCookies({ [SESSION_COOKIE]: "legacy" })).toBe("legacy");
  });

  it("returns null when no session cookie is present", () => {
    expect(deserializeSessionCookies({ other: "x" })).toBeNull();
  });

  it("clears every session cookie variant", () => {
    const cleared = clearSessionCookies([
      SESSION_COOKIE,
      `${SESSION_COOKIE}.0`,
      `${SESSION_COOKIE}.1`,
      "unrelated",
    ]);
    const names = cleared.map((h) => cookieFromHeader(h)[0]);
    expect(names).toEqual([SESSION_COOKIE, `${SESSION_COOKIE}.0`, `${SESSION_COOKIE}.1`]);
    expect(cleared.every((h) => h.includes("Max-Age=0"))).toBe(true);
  });
});

describe("isSessionExpired", () => {
  it("reports expired when expiresAt has passed", () => {
    expect(isSessionExpired({ accessToken: "a", expiresAt: 1000 }, 1001)).toBe(true);
    expect(isSessionExpired({ accessToken: "a", expiresAt: 1000 }, 1000)).toBe(true);
  });

  it("reports unexpired when expiresAt is in the future", () => {
    expect(isSessionExpired({ accessToken: "a", expiresAt: 1000 }, 999)).toBe(false);
  });

  it("treats an unknown expiry as unexpired (provider is the arbiter)", () => {
    expect(isSessionExpired({ accessToken: "a" }, 999)).toBe(false);
  });
});

describe("session cookie name override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to hercules_session", () => {
    expect(sessionCookieBase()).toBe(SESSION_COOKIE);
    expect(sessionChunkName(0)).toBe(`${SESSION_COOKIE}.0`);
  });

  it("honors HERCULES_AUTH_COOKIE_NAME across name, chunking, reads, and clears", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_NAME", "custom_session");
    expect(sessionCookieBase()).toBe("custom_session");
    expect(sessionChunkName(1)).toBe("custom_session.1");
    expect(deserializeSessionCookies({ "custom_session.0": "abc" })).toBe("abc");
    // The default-named cookie is no longer treated as a session cookie.
    expect(deserializeSessionCookies({ [SESSION_COOKIE]: "abc" })).toBeNull();
    const cleared = clearSessionCookies(["custom_session", "custom_session.0", SESSION_COOKIE]);
    expect(cleared.map((h) => cookieFromHeader(h)[0])).toEqual([
      "custom_session",
      "custom_session.0",
    ]);
  });
});

describe("session cookie domain", () => {
  it("stamps Domain on fresh chunks and deletes stale chunks domain-scoped and host-only", () => {
    const headers = serializeSessionCookies("small", { path: "/", domain: ".example.com" }, [
      `${SESSION_COOKIE}.0`,
      `${SESSION_COOKIE}.1`,
    ]);
    const [fresh, ...deletes] = headers;
    expect(fresh).toContain("Domain=.example.com");
    expect(fresh).not.toContain("Max-Age=0");
    // The stale `.1` chunk is expired twice — domain-scoped and host-only —
    // and the written `.0` gets a host-only delete for the pre-migration
    // cookie that would otherwise shadow it.
    expect(deletes.map((h) => cookieFromHeader(h)[0])).toEqual([
      `${SESSION_COOKIE}.1`,
      `${SESSION_COOKIE}.1`,
      `${SESSION_COOKIE}.0`,
    ]);
    expect(deletes.every((h) => h.includes("Max-Age=0"))).toBe(true);
    expect(deletes.filter((h) => h.includes("Domain=.example.com"))).toHaveLength(1);
  });

  it("expires host-only cookies shadowing the written chunk names", () => {
    // Migration: the request still carries chunks set before the domain was
    // configured. The written `.0` gets a host-only delete alongside the
    // domain-scoped set, or the old host-only `.0` shadows it on reads.
    const headers = serializeSessionCookies("small", { path: "/", domain: ".example.com" }, [
      `${SESSION_COOKIE}.0`,
    ]);
    const hostOnlyDeletes = headers.filter(
      (h) => h.includes("Max-Age=0") && !h.includes("Domain="),
    );
    expect(hostOnlyDeletes).toHaveLength(1);
    expect(hostOnlyDeletes[0]).toContain(`${SESSION_COOKIE}.0=;`);
  });

  it("adds no shadow deletes when the request carries no session cookies", () => {
    const headers = serializeSessionCookies("small", { path: "/", domain: ".example.com" }, []);
    expect(headers).toHaveLength(1);
    expect(headers[0]).not.toContain("Max-Age=0");
  });

  it("clears each cookie domain-scoped and host-only on sign-out", () => {
    const cleared = clearSessionCookies([`${SESSION_COOKIE}.0`], { domain: ".example.com" });
    // A domain-scoped delete can't remove a host-only cookie set before the
    // domain was configured, so both variants must be expired.
    expect(cleared).toHaveLength(2);
    expect(cleared.every((h) => h.startsWith(`${SESSION_COOKIE}.0=;`))).toBe(true);
    expect(cleared.every((h) => h.includes("Max-Age=0"))).toBe(true);
    expect(cleared.filter((h) => h.includes("Domain=.example.com"))).toHaveLength(1);
  });
});
