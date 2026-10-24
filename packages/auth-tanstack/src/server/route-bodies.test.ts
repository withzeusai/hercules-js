import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_COOKIE_MAX_AGE, encodePkceState, pkceCookieName } from "./config";
import { setAuthOptions } from "./auth-options";
import {
  AUTH_ERROR_PARAM,
  OAuthProviderError,
  OAuthStateMismatchError,
  PKCECookieMissingError,
} from "./errors";
import { buildRedirectUrl, handleCallbackInternal, handleSignInInternal } from "./route-bodies";
import { unsealSession } from "./session";

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  None: vi.fn(() => undefined),
  randomPKCECodeVerifier: vi.fn(() => "test-verifier"),
  calculatePKCECodeChallenge: vi.fn(async () => "test-challenge"),
  randomState: vi.fn(() => "fresh-state"),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://idp.example.com/authorize");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }),
  buildEndSessionUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  refreshTokenGrant: vi.fn(),
}));

import * as oidc from "openid-client";

const STATE = "abc123";
const VERIFIER_COOKIE = pkceCookieName(STATE);

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-token",
    id_token: "id-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    scope: "openid profile email offline_access",
    claims: () => ({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  };
}

function callbackRequest({
  code = "auth-code",
  state = STATE,
  returnPathname,
  redirectUri,
  cookie,
  url: base = "https://app.example.com/auth/callback",
  params = {},
}: {
  code?: string | null;
  state?: string | null;
  returnPathname?: string;
  redirectUri?: string;
  cookie?: string | null;
  url?: string;
  params?: Record<string, string>;
} = {}): Request {
  const url = new URL(base);
  if (code) url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const verifier = encodePkceState({ verifier: "test-verifier", returnPathname, redirectUri });
  const header = cookie === undefined ? `${VERIFIER_COOKIE}=${verifier}` : cookie;
  return new Request(url, { headers: header ? { cookie: header } : {} });
}

/** The redirect target of a 302, parsed. */
function locationOf(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location")!);
}

function expiresVerifier(response: Response): boolean {
  return response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`));
}

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://issuer.example.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
  process.env.HERCULES_AUTH_COOKIE_PASSWORD = "test-password-at-least-32-characters-long";
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setAuthOptions({});
});

describe("buildRedirectUrl", () => {
  const ORIGIN = "https://app.example.com";

  it("resolves a plain path", () => {
    expect(buildRedirectUrl(ORIGIN, "/dashboard").toString()).toBe(
      "https://app.example.com/dashboard",
    );
  });

  it("keeps the query of a path with search params", () => {
    expect(buildRedirectUrl(ORIGIN, "/dashboard?tab=1&x=2").toString()).toBe(
      "https://app.example.com/dashboard?tab=1&x=2",
    );
  });

  it("anchors an absolute URL to the callback origin (open-redirect hardening)", () => {
    expect(buildRedirectUrl(ORIGIN, "https://evil.example.com/phish").toString()).toBe(
      "https://app.example.com/phish",
    );
  });

  it("anchors a protocol-relative URL to the callback origin", () => {
    expect(buildRedirectUrl(ORIGIN, "//evil.example.com/phish").toString()).toBe(
      "https://app.example.com/phish",
    );
  });
});

describe("handleCallbackInternal", () => {
  it("completes the flow: long-lived session cookie, anchored redirect, verifier cleared", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(
      tokenResponse() as unknown as Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
    );

    const response = await handleCallbackInternal(
      callbackRequest({ returnPathname: "/dashboard" }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/dashboard");

    const setCookies = response.headers.getSetCookie();
    const sessionChunk = setCookies.find((h) => h.startsWith("hercules_session.0="));
    expect(sessionChunk).toBeDefined();
    // The session cookie must outlive the access token (carries the refresh token).
    expect(sessionChunk).toContain(`Max-Age=${DEFAULT_SESSION_COOKIE_MAX_AGE}`);

    const sealed = sessionChunk!.split(";")[0]!.slice("hercules_session.0=".length);
    const session = await unsealSession(sealed);
    expect(session).toMatchObject({
      accessToken: "access-token",
      idToken: "id-token",
      refreshToken: "refresh-token",
    });

    // This flow's verifier is expired on the response.
    expect(setCookies.some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`))).toBe(true);
  });

  it("anchors a poisoned absolute returnPathname to the callback origin", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(
      tokenResponse() as unknown as Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
    );

    const response = await handleCallbackInternal(
      callbackRequest({ returnPathname: "https://evil.example.com/phish" }),
    );

    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/phish");
  });

  it("passes an OAuthStateMismatchError to onError when state is missing", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(callbackRequest({ state: null }), { onError });

    expect(response.status).toBe(400);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatchObject({ reason: "invalid_callback" });
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(OAuthStateMismatchError);
  });

  it("passes a PKCECookieMissingError to onError for an unknown sign-in state", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(callbackRequest({ cookie: null }), { onError });

    expect(response.status).toBe(400);
    expect(onError.mock.calls[0]![0]).toMatchObject({ reason: "sign_in_expired" });
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(PKCECookieMissingError);
  });

  it("evicts the flow's verifier when the code is missing", async () => {
    const response = await handleCallbackInternal(callbackRequest({ code: null }));

    expect(locationOf(response).searchParams.get(AUTH_ERROR_PARAM)).toBe("invalid_callback");
    expect(expiresVerifier(response)).toBe(true);
  });

  it("appends the verifier-delete cookies onto an onError response", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(callbackRequest({ code: null }), { onError });

    expect(await response.text()).toBe("handled");
    expect(response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`))).toBe(
      true,
    );
  });

  it("clones an immutable onError response to attach the delete cookies", async () => {
    const onError = vi.fn(async () => Response.redirect("https://app.example.com/signin", 302));
    const response = await handleCallbackInternal(callbackRequest({ code: null }), { onError });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example.com/signin");
    expect(response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`))).toBe(
      true,
    );
  });

  it("clears the verifier and reports 500 when the token exchange fails", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockRejectedValue(new Error("exchange failed"));

    const response = await handleCallbackInternal(callbackRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Token exchange failed" });
    expect(expiresVerifier(response)).toBe(true);
  });

  it("fails the sign-in through onError when onSuccess throws", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(
      tokenResponse() as unknown as Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
    );
    const provisioningError = new Error("provisioning failed");
    const onError = vi.fn(async () => new Response("handled", { status: 403 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleCallbackInternal(callbackRequest(), {
      onSuccess: async () => {
        throw provisioningError;
      },
      onError,
    });

    expect(response.status).toBe(403);
    expect(onError.mock.calls[0]![0]).toMatchObject({
      error: provisioningError,
      reason: "on_success_failed",
    });
    // No session is sealed, and the flow's verifier is cleared.
    expect(response.headers.getSetCookie().some((h) => h.startsWith("hercules_session."))).toBe(
      false,
    );
    expect(expiresVerifier(response)).toBe(true);
  });

  it("reports 500 when onSuccess throws and no error handling is configured", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(
      tokenResponse() as unknown as Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleCallbackInternal(callbackRequest(), {
      onSuccess: () => {
        throw new Error("provisioning failed");
      },
    });

    // Not recoverable by signing in again, so no redirect back into the app.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "onSuccess failed" });
    expect(expiresVerifier(response)).toBe(true);
  });
});

describe("handleCallbackInternal recoverable failures", () => {
  it("sends an unknown or expired sign-in back to / with a reason instead of JSON", async () => {
    // `curl /auth/callback?code=a&state=xyz` with no matching cookie.
    const response = await handleCallbackInternal(
      callbackRequest({ code: "a", state: "xyz", cookie: null }),
    );

    const location = locationOf(response);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("sign_in_expired");
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("sends a bookmarked callback with no parameters back to /", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({ code: null, state: null, cookie: null }),
    );

    const location = locationOf(response);
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("invalid_callback");
  });

  it("returns a cancelled sign-in to the page it started from", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({
        code: null,
        returnPathname: "/pricing?plan=pro#faq",
        params: { error: "access_denied", error_description: "The user cancelled" },
      }),
    );

    const location = locationOf(response);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/pricing");
    expect(location.searchParams.get("plan")).toBe("pro");
    expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("access_denied");
    expect(location.hash).toBe("#faq");
    expect(expiresVerifier(response)).toBe(true);
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("reports other provider errors as provider_error and hands onError the details", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(
      callbackRequest({
        code: null,
        returnPathname: "/settings",
        params: { error: "login_required" },
      }),
      { onError },
    );

    expect(await response.text()).toBe("handled");
    expect(expiresVerifier(response)).toBe(true);
    const params = onError.mock.calls[0]![0];
    expect(params).toMatchObject({ reason: "provider_error", returnPathname: "/settings" });
    expect(params.error).toBeInstanceOf(OAuthProviderError);
    expect(params.error).toMatchObject({ code: "login_required" });
  });

  it("anchors a poisoned returnPathname to the app's origin", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({
        code: null,
        returnPathname: "https://evil.example.com/phish",
        params: { error: "access_denied" },
      }),
    );

    const location = locationOf(response);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.pathname).toBe("/phish");
  });

  it("goes home when the stored returnPathname cannot be parsed", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({
        code: null,
        returnPathname: "https://exa mple.com/x",
        params: { error: "access_denied" },
      }),
    );

    expect(locationOf(response).toString()).toBe(
      "https://app.example.com/?auth_error=access_denied",
    );
  });

  it("redirects to the public origin sealed with the flow, not the internal hop", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({
        url: "http://10.0.0.5:3000/auth/callback",
        code: null,
        returnPathname: "/projects",
        redirectUri: "https://app.example.com/auth/callback",
        params: { error: "access_denied" },
      }),
    );

    expect(locationOf(response).origin).toBe("https://app.example.com");
  });

  it("falls back to the configured public origin when no cookie is readable", async () => {
    setAuthOptions({ redirectUri: "https://app.example.com/auth/callback" });
    const response = await handleCallbackInternal(
      callbackRequest({ url: "http://10.0.0.5:3000/auth/callback", cookie: null }),
    );

    expect(locationOf(response).toString()).toBe(
      "https://app.example.com/?auth_error=sign_in_expired",
    );
  });

  it("still honors errorRedirectUrl", async () => {
    const response = await handleCallbackInternal(
      callbackRequest({ code: null, params: { error: "access_denied" } }),
      { errorRedirectUrl: "/sign-in?error=auth_failed" },
    );

    expect(locationOf(response).toString()).toBe(
      "https://app.example.com/sign-in?error=auth_failed",
    );
    expect(expiresVerifier(response)).toBe(true);
  });

  it.each([
    ["not base64url", "%%%not-base64%%%"],
    ["truncated JSON", "eyJ2IjoidGVzdC12ZXJp"],
    ["JSON without a verifier", "eyJyIjoiL3gifQ"],
    ["a bare string", "plain-old-garbage-value"],
  ])("treats an unreadable verifier cookie (%s) like an expired one", async (_label, value) => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const withHandler = await handleCallbackInternal(
      callbackRequest({ cookie: `${VERIFIER_COOKIE}=${value}` }),
      { onError },
    );
    const withDefault = await handleCallbackInternal(
      callbackRequest({ cookie: `${VERIFIER_COOKIE}=${value}` }),
    );

    // Never reaches the token exchange (which would answer 500).
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]![0]).toMatchObject({ reason: "sign_in_expired" });
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(PKCECookieMissingError);
    expect(locationOf(withDefault).searchParams.get(AUTH_ERROR_PARAM)).toBe("sign_in_expired");
    // The bad cookie is expired so it stops riding along.
    expect(expiresVerifier(withHandler)).toBe(true);
    expect(expiresVerifier(withDefault)).toBe(true);
  });
});

describe("handleSignInInternal", () => {
  it("forwards maxAge and loginHint as OIDC max_age / login_hint", async () => {
    const response = await handleSignInInternal(
      new Request("https://app.example.com/auth/sign-in"),
      { maxAge: 300, loginHint: "user@example.com" },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("max_age")).toBe("300");
    expect(location.searchParams.get("login_hint")).toBe("user@example.com");
    expect(location.searchParams.get("code_challenge")).toBe("test-challenge");

    // The flow's PKCE verifier cookie is set for the callback to consume.
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((h) => h.startsWith(pkceCookieName("fresh-state")))).toBe(true);
  });

  it("sends prompt=login by default and honors a caller override", async () => {
    const promptOf = async (options?: { prompt?: string }) => {
      const response = await handleSignInInternal(
        new Request("https://app.example.com/auth/sign-in"),
        options,
      );
      return new URL(response.headers.get("Location")!).searchParams.get("prompt");
    };

    expect(await promptOf()).toBe("login");
    expect(await promptOf({ prompt: "select_account" })).toBe("select_account");
    expect(await promptOf({ prompt: "" })).toBeNull();
  });

  it("expires the oldest pending sign-ins and keeps the newest", async () => {
    // The browser sends same-path cookies oldest first.
    const pending = Array.from({ length: 12 }, (_, index) => pkceCookieName(`old-${index}`));
    const cookie = pending.map((name) => `${name}=x`).join("; ");

    const response = await handleSignInInternal(
      new Request("https://app.example.com/auth/sign-in", { headers: { cookie } }),
    );

    const expired = response.headers
      .getSetCookie()
      .filter((h) => h.includes("Max-Age=0"))
      .map((h) => h.split("=")[0]);
    // 12 pending + this flow, capped at 10: the 3 oldest go.
    expect(new Set(expired)).toEqual(new Set(pending.slice(0, 3)));
  });
});
