import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAuthClient, readSignedQuery } from "./client";
import { readEmbeddedSignInMetadata, toEmbeddedEndpoint } from "./metadata";

const ORIGIN = "https://theirapp.com";
const SIGNED =
  "client_id=c&redirect_uri=https%3A%2F%2Ftheirapp.com%2Fauth%2Fcallback&exp=1&sig=abc";
const CALLBACK = `${ORIGIN}/auth/callback?code=xyz&state=s`;

function fakeLocation(search = "", pathname = "/sign-in") {
  return {
    origin: ORIGIN,
    search,
    pathname,
    href: `${ORIGIN}${pathname}${search}`,
    assign: vi.fn(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createEmbeddedAuthClient", () => {
  it("signs in with the page's signed query and returns the callback redirect", async () => {
    const fetch = vi.fn(async () => jsonResponse({ redirect: true, url: CALLBACK }));
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation(`?${SIGNED}`) });

    const result = await client.signInWithPassword({
      email: "a@example.com",
      password: "pw",
      captchaToken: "t",
    });

    expect(result).toEqual({ ok: true, status: "redirect", redirectTo: CALLBACK });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/_hercules/auth/sign-in/email");
    expect(init.headers).toMatchObject({ "x-captcha-response": "t" });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@example.com",
      password: "pw",
      callbackURL: `${ORIGIN}/sign-in?${SIGNED}`,
      oauth_query: SIGNED,
    });
  });

  it("starts an authorization request when the page has no signed query", async () => {
    const startAuthorization = vi.fn(
      async () => `${ORIGIN}/_hercules/auth/oauth2/authorize?client_id=c`,
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ redirect: true, url: `/sign-in?${SIGNED}` }))
      .mockResolvedValueOnce(jsonResponse({ url: "https://accounts.google.com/o/oauth2/auth?x" }));
    const client = createEmbeddedAuthClient({
      fetch,
      startAuthorization,
      location: fakeLocation("", "/pricing"),
      isFramed: () => false,
    });

    const result = await client.signInWithSocial({ provider: "google" });

    expect(startAuthorization).toHaveBeenCalledWith({ returnTo: "/pricing" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { accept: "application/json" } });
    expect(result).toEqual({
      ok: true,
      status: "redirect",
      redirectTo: "https://accounts.google.com/o/oauth2/auth?x",
    });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      provider: "google",
      callbackURL: ORIGIN,
      errorCallbackURL: `${ORIGIN}/pricing`,
      oauth_query: SIGNED,
    });
  });

  it("skips the sign-in when authorize finds an existing session", async () => {
    const fetch = vi.fn(async () => jsonResponse({ redirect: true, url: CALLBACK }));
    const client = createEmbeddedAuthClient({
      fetch,
      startAuthorization: async () => `${ORIGIN}/_hercules/auth/oauth2/authorize`,
      location: fakeLocation("", "/"),
      isFramed: () => false,
    });

    const result = await client.signInWithSocial({ provider: "google" });

    expect(result).toEqual({ ok: true, status: "redirect", redirectTo: CALLBACK });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports a missing authorization request instead of signing in without one", async () => {
    const fetch = vi.fn();
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation("") });

    const result = await client.signInWithEmailOtp({ email: "a@example.com", otp: "123456" });

    expect(result).toMatchObject({ ok: false, error: { code: "NO_AUTHORIZATION_REQUEST" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes server errors through", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        401,
      ),
    );
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation(`?${SIGNED}`) });

    const result = await client.signInWithPassword({ email: "a@example.com", password: "x" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
        status: 401,
      },
    });
  });

  it("continues past the sign-up page after creating an account", async () => {
    const signUpQuery = `${SIGNED}&prompt=create`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ redirect: true, url: `/sign-in?${signUpQuery}` }))
      .mockResolvedValueOnce(jsonResponse({ redirect: true, url: CALLBACK }));
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation(`?${signUpQuery}`) });

    const result = await client.signUpWithPassword({ email: "a@example.com", password: "pw" });

    expect(result).toEqual({ ok: true, status: "redirect", redirectTo: CALLBACK });
    expect(fetch.mock.calls[1]![0]).toBe("/_hercules/auth/oauth2/continue");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      created: true,
      oauth_query: signUpQuery,
    });
  });

  it("reports a sign-up that must verify its email", async () => {
    const fetch = vi.fn(async () => jsonResponse({ token: null, user: { id: "u1" } }));
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation(`?${SIGNED}`) });

    const result = await client.signUpWithPassword({ email: "a@example.com", password: "pw" });

    expect(result).toEqual({ ok: true, status: "verify-email" });
  });

  it("carries an auto-generated username through to the result", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ redirect: true, url: CALLBACK, username: "member48213977" }),
    );
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation(`?${SIGNED}`) });

    expect(await client.signUpWithUsername({ password: "pw" })).toEqual({
      ok: true,
      status: "redirect",
      redirectTo: CALLBACK,
      username: "member48213977",
    });
  });

  it("reads the sign-in config", async () => {
    const fetch = vi.fn(async () => jsonResponse({ appName: "Recipe Pro" }));
    const client = createEmbeddedAuthClient({ fetch, location: fakeLocation() });

    expect(await client.getConfig()).toEqual({ ok: true, data: { appName: "Recipe Pro" } });
    expect(fetch.mock.calls[0]![0]).toBe("/_hercules/auth/config");
  });

  it("reads sign-up requests and page errors from the URL", () => {
    const client = createEmbeddedAuthClient({
      location: fakeLocation(`?${SIGNED}&prompt=create&error=access_denied`),
    });

    expect(client.hasPendingSignIn()).toBe(true);
    expect(client.isSignUpRequest()).toBe(true);
    expect(client.pageError()).toMatchObject({ code: "access_denied" });
  });
});

describe("readSignedQuery", () => {
  it("needs a signature", () => {
    expect(readSignedQuery("?client_id=c")).toBeNull();
    expect(readSignedQuery(`?${SIGNED}`)).toBe(SIGNED);
  });
});

describe("embedded sign-in metadata", () => {
  it("reads the discovery field", () => {
    expect(
      readEmbeddedSignInMetadata({
        hercules_embedded_sign_in: {
          auth_base_path: "/_hercules/auth",
          sign_in_path: "/login",
        },
      }),
    ).toEqual({
      authBasePath: "/_hercules/auth",
      signInPath: "/login",
      signUpPath: "/login",
    });
    expect(readEmbeddedSignInMetadata({})).toBeNull();
    expect(
      readEmbeddedSignInMetadata({
        hercules_embedded_sign_in: { auth_base_path: "//evil.example", sign_in_path: "/login" },
      }),
    ).toBeNull();
  });

  it("moves a browser endpoint onto the app origin, keeping the query", () => {
    const moved = toEmbeddedEndpoint(
      new URL("https://tenant.hercules-auth.com/api/auth/oauth2/authorize?client_id=c&state=s"),
      ORIGIN,
      { authBasePath: "/_hercules/auth" },
    );
    expect(moved.toString()).toBe(`${ORIGIN}/_hercules/auth/oauth2/authorize?client_id=c&state=s`);
  });
});
