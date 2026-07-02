import { describe, it, expect } from "vitest";
import { decodePkceState, encodePkceState, pkceCookieName } from "./config";

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
