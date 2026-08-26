import { afterEach, describe, expect, it, vi } from "vitest";
import { setAuthOptions } from "./auth-options";
import {
  cookieSecurity,
  resolveCallbackUrl,
  resolveOrigin,
  resolvePostLogoutRedirectUri,
  resolveRedirectUri,
  toCookieSameSite,
} from "./request-url";

function request(url: string): Request {
  return new Request(url);
}

afterEach(() => {
  // Reset the module-level middleware options between tests.
  setAuthOptions({});
  vi.unstubAllEnvs();
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

describe("resolvePostLogoutRedirectUri", () => {
  // The provider compares this value to its registered list as a plain string,
  // so a trailing slash the registration doesn't have means no redirect at all.
  it("defaults to the bare origin, with no trailing slash", () => {
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://app.example.com",
    );
  });

  it("resolves a root returnTo to the bare origin", () => {
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"), "/")).toBe(
      "https://app.example.com",
    );
  });

  it("keeps a non-root returnTo's path, query, and hash", () => {
    expect(
      resolvePostLogoutRedirectUri(request("https://app.example.com/account"), "/bye?a=1#x"),
    ).toBe("https://app.example.com/bye?a=1#x");
  });

  it("anchors an off-origin returnTo to this app's origin", () => {
    expect(
      resolvePostLogoutRedirectUri(
        request("https://app.example.com/account"),
        "https://evil.test/x",
      ),
    ).toBe("https://app.example.com/x");
  });

  it("uses the configured origin behind a TLS-terminating proxy", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(resolvePostLogoutRedirectUri(request("http://internal:8080/account"))).toBe(
      "https://app.example.com",
    );
  });

  it("uses the configured postLogoutRedirectUri when no returnTo is given", () => {
    setAuthOptions({ postLogoutRedirectUri: "https://marketing.example.com/farewell" });
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://marketing.example.com/farewell",
    );
  });

  // The configured value is the string the app registered, and the provider
  // compares it character for character, so an app whose provider holds the
  // trailing-slash spelling must be able to send it back.
  it("sends a configured absolute URI verbatim, trailing slash and all", () => {
    setAuthOptions({ postLogoutRedirectUri: "https://marketing.example.com/" });
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://marketing.example.com/",
    );
  });

  it("sends a configured absolute URI from the environment verbatim", () => {
    vi.stubEnv("HERCULES_AUTH_POST_LOGOUT_REDIRECT_URI", "https://app.example.com/");
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://app.example.com/",
    );
  });

  it("renders a configured relative value like the default", () => {
    setAuthOptions({ postLogoutRedirectUri: "/" });
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to the environment when no option is configured", () => {
    vi.stubEnv("HERCULES_AUTH_POST_LOGOUT_REDIRECT_URI", "https://app.example.com/signed-out");
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://app.example.com/signed-out",
    );
  });

  it("lets returnTo win over the configured value", () => {
    setAuthOptions({ postLogoutRedirectUri: "https://marketing.example.com/farewell" });
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"), "/bye")).toBe(
      "https://app.example.com/bye",
    );
  });

  it("falls back to the origin when the configured value is malformed", () => {
    setAuthOptions({ postLogoutRedirectUri: "http://[" });
    expect(resolvePostLogoutRedirectUri(request("https://app.example.com/account"))).toBe(
      "https://app.example.com",
    );
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

  it("prefers the sealed redirect_uri, keeping the request's query", () => {
    // Even the internal proxy hop and query are on the request; the sealed value
    // supplies origin + path so the token exchange matches the sign-in exactly.
    expect(
      resolveCallbackUrl(
        request("http://internal:8080/auth/callback?code=abc&state=xyz"),
        "https://app.example.com/auth/callback",
      ).toString(),
    ).toBe("https://app.example.com/auth/callback?code=abc&state=xyz");
  });

  it("honors a per-request redirect_uri override that differs from the middleware config", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(
      resolveCallbackUrl(
        request("https://other.example.com/cb?code=abc"),
        "https://other.example.com/cb",
      ).toString(),
    ).toBe("https://other.example.com/cb?code=abc");
  });

  it("falls back to origin reconstruction when the sealed value is unparsable", () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    expect(
      resolveCallbackUrl(
        request("http://internal:8080/auth/callback?code=abc"),
        "not a url",
      ).toString(),
    ).toBe("https://app.example.com/auth/callback?code=abc");
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

describe("redirectUri environment fallback", () => {
  it("resolveOrigin falls back to HERCULES_AUTH_REDIRECT_URI when no middleware option is set", () => {
    vi.stubEnv("HERCULES_AUTH_REDIRECT_URI", "https://app.example.com/auth/callback");
    expect(resolveOrigin(request("http://internal:8080/x"))).toBe("https://app.example.com");
  });

  it("resolveRedirectUri falls back to the environment value", () => {
    vi.stubEnv("HERCULES_AUTH_REDIRECT_URI", "https://app.example.com/auth/callback");
    expect(resolveRedirectUri(request("http://internal:8080/auth/sign-in"))).toBe(
      "https://app.example.com/auth/callback",
    );
  });

  it("the middleware option wins over the environment", () => {
    vi.stubEnv("HERCULES_AUTH_REDIRECT_URI", "https://env.example.com/cb");
    setAuthOptions({ redirectUri: "https://opt.example.com/cb" });
    expect(resolveRedirectUri(request("http://internal/x"))).toBe("https://opt.example.com/cb");
  });

  it("cookieSecurity derives the protocol from the environment value", () => {
    vi.stubEnv("HERCULES_AUTH_REDIRECT_URI", "https://app.example.com/auth/callback");
    expect(cookieSecurity(request("http://internal:8080/x"))).toEqual({
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
