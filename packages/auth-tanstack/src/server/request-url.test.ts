import { afterEach, describe, expect, it } from "vitest";
import { setAuthOptions } from "./auth-options";
import {
  cookieSecurity,
  resolveCallbackUrl,
  resolveOrigin,
  resolveRedirectUri,
  toCookieSameSite,
} from "./request-url";

function request(url: string): Request {
  return new Request(url);
}

afterEach(() => {
  // Reset the module-level middleware options between tests.
  setAuthOptions({});
});

describe("resolveOrigin", () => {
  it("uses the request origin when no redirectUri is configured", () => {
    expect(resolveOrigin(request("http://localhost:3000/auth/sign-in"))).toBe(
      "http://localhost:3000",
    );
  });

  it("prefers the configured redirectUri origin (proxy-correct)", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(resolveOrigin(request("http://internal:8080/auth/sign-in"))).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to the request origin when redirectUri is malformed", () => {
    setAuthOptions({ redirectUri: "/relative/callback" });
    expect(resolveOrigin(request("http://localhost:3000/x"))).toBe("http://localhost:3000");
  });
});

describe("resolveRedirectUri", () => {
  it("defaults to the callback path resolved against the request origin", () => {
    expect(resolveRedirectUri(request("http://localhost:3000/auth/sign-in"))).toBe(
      "http://localhost:3000/auth/callback",
    );
  });

  it("uses the configured redirectUri when set", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(resolveRedirectUri(request("http://internal:8080/auth/sign-in"))).toBe(
      "https://app.example.com/auth/callback",
    );
  });

  it("lets a per-call override win", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(
      resolveRedirectUri(request("http://internal/auth/sign-in"), "https://other.example.com/cb"),
    ).toBe("https://other.example.com/cb");
  });
});

describe("resolveCallbackUrl", () => {
  it("returns the request URL (origin, path, query) when no redirectUri is configured", () => {
    expect(
      resolveCallbackUrl(
        request("http://localhost:3000/auth/callback?code=abc&state=xyz"),
      ).toString(),
    ).toBe("http://localhost:3000/auth/callback?code=abc&state=xyz");
  });

  it("swaps in the configured public origin while keeping the proxied path and query (proxy-correct)", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(
      resolveCallbackUrl(
        request("http://internal:8080/auth/callback?code=abc&state=xyz"),
      ).toString(),
    ).toBe("https://app.example.com/auth/callback?code=abc&state=xyz");
  });

  it("matches redirect_uri when the configured origin differs from the path (uses the proxied path)", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    // The proxy preserves the path, so the reconstructed URL's origin+path
    // equals the configured redirectUri that the authorization request used.
    const url = resolveCallbackUrl(request("http://internal/auth/callback?code=1"));
    expect(url.origin + url.pathname).toBe("https://app.example.com/auth/callback");
  });

  it("falls back to the request origin when redirectUri is malformed", () => {
    setAuthOptions({ redirectUri: "not a url" });
    expect(
      resolveCallbackUrl(request("http://localhost:3000/auth/callback?code=abc")).toString(),
    ).toBe("http://localhost:3000/auth/callback?code=abc");
  });
});

describe("cookieSecurity", () => {
  it("defaults to SameSite=None; Secure over HTTPS (embed-safe)", () => {
    expect(cookieSecurity(request("https://app.example.com/"))).toEqual({
      secure: true,
      sameSite: "None",
    });
  });

  it("defaults to SameSite=Lax (insecure) over plain HTTP", () => {
    expect(cookieSecurity(request("http://localhost:3000/"))).toEqual({
      secure: false,
      sameSite: "Lax",
    });
  });

  it("derives the protocol from the configured redirectUri (behind a proxy)", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(cookieSecurity(request("http://internal:8080/auth/sign-in"))).toEqual({
      secure: true,
      sameSite: "None",
    });
  });

  it("honors cookieSameSite=lax over HTTPS (still Secure)", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/cb", cookieSameSite: "lax" });
    expect(cookieSecurity(request("http://internal/x"))).toEqual({
      secure: true,
      sameSite: "Lax",
    });
  });

  it("forces Secure when cookieSameSite=none even over HTTP", () => {
    setAuthOptions({ cookieSameSite: "none" });
    expect(cookieSecurity(request("http://localhost:3000/"))).toEqual({
      secure: true,
      sameSite: "None",
    });
  });

  it("fails closed to Secure when neither redirectUri nor request URL parses", () => {
    setAuthOptions({ redirectUri: "not a url" });
    expect(cookieSecurity(request("http://localhost:3000/"))).toEqual({
      secure: true,
      sameSite: "None",
    });
  });
});

describe("toCookieSameSite", () => {
  it("lowercases for the cookie-spec casing TanStack expects", () => {
    expect(toCookieSameSite("None")).toBe("none");
    expect(toCookieSameSite("Lax")).toBe("lax");
    expect(toCookieSameSite("Strict")).toBe("strict");
  });
});
