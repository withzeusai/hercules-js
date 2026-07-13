import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SESSION_COOKIE_MAX_AGE,
  encodePkceState,
  pkceCookieName,
} from "./config";
import { OAuthStateMismatchError, PKCECookieMissingError } from "./errors";
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
    scope: "openid profile email",
    claims: () => ({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  };
}

function callbackRequest({
  code = "auth-code",
  state = STATE,
  returnPathname,
  cookie,
}: {
  code?: string | null;
  state?: string | null;
  returnPathname?: string;
  cookie?: string | null;
} = {}): Request {
  const url = new URL("https://app.example.com/auth/callback");
  if (code) url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  const verifier = encodePkceState({ verifier: "test-verifier", returnPathname });
  const header = cookie === undefined ? `${VERIFIER_COOKIE}=${verifier}` : cookie;
  return new Request(url, { headers: header ? { cookie: header } : {} });
}

beforeAll(() => {
  process.env.HERCULES_AUTH_ISSUER_URL = "https://issuer.example.com";
  process.env.HERCULES_AUTH_CLIENT_ID = "test-client";
  process.env.HERCULES_AUTH_COOKIE_PASSWORD = "test-password-at-least-32-characters-long";
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(OAuthStateMismatchError);
  });

  it("passes a PKCECookieMissingError to onError for an unknown sign-in state", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(callbackRequest({ cookie: null }), { onError });

    expect(response.status).toBe(400);
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(PKCECookieMissingError);
  });

  it("evicts the flow's verifier when the code is missing", async () => {
    const response = await handleCallbackInternal(callbackRequest({ code: null }));

    expect(response.status).toBe(400);
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`))).toBe(true);
  });

  it("appends the verifier-delete cookies onto an onError response", async () => {
    const onError = vi.fn(async () => new Response("handled", { status: 400 }));
    const response = await handleCallbackInternal(callbackRequest({ code: null }), { onError });

    expect(await response.text()).toBe("handled");
    expect(
      response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`)),
    ).toBe(true);
  });

  it("clones an immutable onError response to attach the delete cookies", async () => {
    const onError = vi.fn(async () => Response.redirect("https://app.example.com/signin", 302));
    const response = await handleCallbackInternal(callbackRequest({ code: null }), { onError });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example.com/signin");
    expect(
      response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`)),
    ).toBe(true);
  });

  it("clears the verifier and reports 500 when the token exchange fails", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockRejectedValue(new Error("exchange failed"));

    const response = await handleCallbackInternal(callbackRequest());

    expect(response.status).toBe(500);
    expect(
      response.headers.getSetCookie().some((h) => h.startsWith(`${VERIFIER_COOKIE}=;`)),
    ).toBe(true);
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
});
