import { afterEach, describe, it, expect, vi } from "vitest";
import { setAuthOptions } from "./auth-options";
import {
  DEFAULT_SESSION_COOKIE_MAX_AGE,
  MAX_PENDING_SIGN_INS,
  MAX_PKCE_COOKIE_BYTES,
  clientAuthHint,
  decodePkceState,
  encodePkceCookie,
  encodePkceState,
  pkceCookieName,
  sessionCookieDomain,
  sessionCookieMaxAge,
  staleSignInCookieNames,
} from "./config";

describe("pkceCookieName", () => {
  it("namespaces by state", () => {
    expect(pkceCookieName("abc")).toBe("hercules_pkce_abc");
  });
});

describe("PKCE state envelope", () => {
  it("round-trips a verifier and return path", () => {
    const encoded = encodePkceState({ verifier: "v123", returnPathname: "/dashboard?tab=1" });
    expect(decodePkceState(encoded)).toEqual({
      verifier: "v123",
      returnPathname: "/dashboard?tab=1",
    });
  });

  it("round-trips a verifier with no return path", () => {
    const encoded = encodePkceState({ verifier: "v123" });
    expect(decodePkceState(encoded)).toEqual({ verifier: "v123", returnPathname: undefined });
  });

  it("round-trips the sealed redirect_uri", () => {
    const encoded = encodePkceState({
      verifier: "v123",
      returnPathname: "/dashboard",
      redirectUri: "https://app.example.com/auth/callback",
    });
    expect(decodePkceState(encoded)).toEqual({
      verifier: "v123",
      returnPathname: "/dashboard",
      redirectUri: "https://app.example.com/auth/callback",
    });
  });

  it("omits the redirect_uri when not set", () => {
    const encoded = encodePkceState({ verifier: "v123" });
    expect(decodePkceState(encoded)?.redirectUri).toBeUndefined();
  });

  it("produces a cookie-safe value", () => {
    const encoded = encodePkceState({
      verifier: "v123",
      returnPathname: "/a/b",
      redirectUri: "https://app.example.com/auth/callback",
    });
    expect(encoded).not.toMatch(/[;,=\s]/);
  });

  it.each([
    ["a bare string", "raw-verifier-string"],
    ["invalid base64url", "%%%"],
    ["truncated JSON", encodePkceState({ verifier: "v123", returnPathname: "/a" }).slice(0, 12)],
    ["JSON without a verifier", "eyJyIjoiL3gifQ"],
    ["an empty verifier", "eyJ2IjoiIn0"],
    ["JSON null", "bnVsbA"],
  ])("returns undefined for %s", (_label, value) => {
    expect(decodePkceState(value)).toBeUndefined();
  });
});

describe("sessionCookieMaxAge", () => {
  afterEach(() => {
    setAuthOptions({});
    vi.unstubAllEnvs();
  });

  it("defaults to ~400 days, decoupled from token lifetimes", () => {
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_COOKIE_MAX_AGE);
    expect(DEFAULT_SESSION_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 400);
  });

  it("honors HERCULES_AUTH_COOKIE_MAX_AGE", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_MAX_AGE", "86400");
    expect(sessionCookieMaxAge()).toBe(86400);
  });

  it("lets the middleware option win over the environment", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_MAX_AGE", "86400");
    setAuthOptions({ cookieMaxAge: 3600 });
    expect(sessionCookieMaxAge()).toBe(3600);
  });

  it("ignores non-numeric or non-positive values", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_MAX_AGE", "not-a-number");
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_COOKIE_MAX_AGE);
    vi.stubEnv("HERCULES_AUTH_COOKIE_MAX_AGE", "-1");
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_COOKIE_MAX_AGE);
  });
});

describe("sessionCookieDomain", () => {
  afterEach(() => {
    setAuthOptions({});
    vi.unstubAllEnvs();
  });

  it("defaults to host-only (undefined)", () => {
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it("honors HERCULES_AUTH_COOKIE_DOMAIN", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_DOMAIN", ".example.com");
    expect(sessionCookieDomain()).toBe(".example.com");
  });

  it("lets the middleware option win over the environment", () => {
    vi.stubEnv("HERCULES_AUTH_COOKIE_DOMAIN", ".example.com");
    setAuthOptions({ cookieDomain: ".other.com" });
    expect(sessionCookieDomain()).toBe(".other.com");
  });
});

describe("staleSignInCookieNames", () => {
  const pending = (count: number) =>
    Array.from({ length: count }, (_, index) => pkceCookieName(`s${index}`));

  it("expires nothing while the new flow still fits under the cap", () => {
    expect(staleSignInCookieNames(pending(MAX_PENDING_SIGN_INS - 1))).toEqual([]);
  });

  it("expires the oldest flows, which the browser sends first", () => {
    const names = pending(MAX_PENDING_SIGN_INS + 2);
    // Keep the newest MAX − 1 (room for the flow being started).
    expect(staleSignInCookieNames(names)).toEqual(names.slice(0, 3));
  });

  it("ignores cookies that aren't pending sign-ins", () => {
    const names = ["hercules_session.0", ...pending(MAX_PENDING_SIGN_INS), "theme"];
    expect(staleSignInCookieNames(names)).toEqual([pkceCookieName("s0")]);
  });
});

describe("encodePkceCookie", () => {
  const name = pkceCookieName("state");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the return path when the cookie fits", () => {
    const value = encodePkceCookie(name, { verifier: "v", returnPathname: "/dashboard" });
    expect(decodePkceState(value)?.returnPathname).toBe("/dashboard");
  });

  it("drops a return path that would make the browser discard the cookie", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const returnPathname = `/search?q=${"x".repeat(MAX_PKCE_COOKIE_BYTES)}`;

    const value = encodePkceCookie(name, { verifier: "v", returnPathname, redirectUri: "/cb" });

    expect(name.length + value.length).toBeLessThanOrEqual(MAX_PKCE_COOKIE_BYTES);
    expect(decodePkceState(value)).toEqual({ verifier: "v", redirectUri: "/cb" });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("clientAuthHint", () => {
  const invalidClient = Object.assign(new Error("server responded with an error"), {
    error: "invalid_client",
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the secret variable when invalid_client meets a public client", () => {
    vi.stubEnv("HERCULES_AUTH_CLIENT_SECRET", "");
    vi.stubEnv("AUTH_CLIENT_SECRET", "");
    expect(clientAuthHint(invalidClient)).toContain("HERCULES_AUTH_CLIENT_SECRET");
  });

  it("stays quiet when a secret is configured", () => {
    vi.stubEnv("HERCULES_AUTH_CLIENT_SECRET", "s3cret");
    expect(clientAuthHint(invalidClient)).toBeUndefined();
  });

  it("stays quiet for other failures", () => {
    vi.stubEnv("HERCULES_AUTH_CLIENT_SECRET", "");
    vi.stubEnv("AUTH_CLIENT_SECRET", "");
    const invalidGrant = Object.assign(new Error("x"), { error: "invalid_grant" });
    expect(clientAuthHint(invalidGrant)).toBeUndefined();
    expect(clientAuthHint(new Error("network"))).toBeUndefined();
  });
});
