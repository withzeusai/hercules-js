import { afterEach, describe, it, expect, vi } from "vitest";
import { setAuthOptions } from "./auth-options";
import {
  DEFAULT_SESSION_COOKIE_MAX_AGE,
  decodePkceState,
  encodePkceState,
  pkceCookieName,
  sessionCookieDomain,
  sessionCookieMaxAge,
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
    expect(decodePkceState(encoded).redirectUri).toBeUndefined();
  });

  it("produces a cookie-safe value", () => {
    const encoded = encodePkceState({
      verifier: "v123",
      returnPathname: "/a/b",
      redirectUri: "https://app.example.com/auth/callback",
    });
    expect(encoded).not.toMatch(/[;,=\s]/);
  });

  it("treats a bare (non-envelope) value as the verifier for back-compat", () => {
    expect(decodePkceState("raw-verifier-string")).toEqual({ verifier: "raw-verifier-string" });
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
