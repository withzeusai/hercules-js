// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFramed, resolveSignOutNavigation, signOutFallback } from "./sign-out-redirect";

const origin = "https://app.example.com";

describe("signOutFallback", () => {
  it.each([
    undefined,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,test",
    "https://app.example.com@evil.example",
    "http://[",
  ])("falls back to the app home for %j", (returnTo) =>
    expect(signOutFallback(returnTo, origin)).toBe(`${origin}/`),
  );

  it.each([
    "/signed-out?reason=user#done",
    "signed-out?reason=user#done",
    `${origin}/signed-out?reason=user#done`,
  ])("preserves a same-origin return target %j", (returnTo) =>
    expect(signOutFallback(returnTo, origin)).toBe(`${origin}/signed-out?reason=user#done`),
  );
});

const END_SESSION = "https://auth.example.com/oidc/session/end";

function endSessionUrl(postLogoutRedirectUri = `${origin}/signed-out`): string {
  const url = new URL(END_SESSION);
  url.searchParams.set("id_token_hint", "id-token");
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return url.toString();
}

function stubFetch() {
  const fetch = vi.fn(async () => new Response(null));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("isFramed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false at the top level", () => {
    expect(isFramed()).toBe(false);
  });

  it("is true under a different top window", () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    expect(isFramed()).toBe(true);
  });

  it("is true when a cross-origin parent blocks access to the top window", () => {
    vi.spyOn(window, "top", "get").mockImplementation(() => {
      throw new DOMException("Blocked a frame", "SecurityError");
    });
    expect(isFramed()).toBe(true);
  });
});

describe("resolveSignOutNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("navigates to the end-session URL at the top level", async () => {
    const fetch = stubFetch();
    const url = endSessionUrl();

    expect(await resolveSignOutNavigation(url, origin)).toBe(url);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a different top window", top: () => ({}) as Window },
    {
      name: "an inaccessible top window",
      top: (): Window => {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    },
  ])("ends the session in the background under $name", async ({ top }) => {
    vi.spyOn(window, "top", "get").mockImplementation(top);
    const fetch = stubFetch();
    const url = endSessionUrl();

    expect(await resolveSignOutNavigation(url, origin)).toBe(`${origin}/signed-out`);
    expect(fetch).toHaveBeenCalledWith(url, {
      mode: "no-cors",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps a framed app on its own origin after sign-out", async () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    stubFetch();

    expect(await resolveSignOutNavigation(endSessionUrl("https://evil.example/"), origin)).toBe(
      `${origin}/`,
    );
  });

  it.each([`${origin}/signed-out`, "https://elsewhere.example/signed-out"])(
    "navigates a framed app directly to %j when no session needs ending",
    async (url) => {
      vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
      const fetch = stubFetch();

      expect(await resolveSignOutNavigation(url, origin)).toBe(url);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("still signs out locally when the background request fails", async () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    expect(await resolveSignOutNavigation(endSessionUrl(), origin)).toBe(`${origin}/signed-out`);
  });

  it("stops waiting for a background request that hangs", async () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Promise<Response>(() => {});
      }),
    );

    expect(await resolveSignOutNavigation(endSessionUrl(), origin)).toBe(`${origin}/signed-out`);
    expect(timeout).toHaveBeenCalledWith(5000);
  });
});
