import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, configure } from "@testing-library/react";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules.js";
import React from "react";

configure({ reactStrictMode: true });

function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
}

const mockSigninSilent = vi.fn();

let mockAuthState: Record<string, unknown> = {};

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
}));

type CapturedUseAuth = () => {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
};

let capturedUseAuth: CapturedUseAuth | null = null;

vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: ReactNode;
    useAuth: CapturedUseAuth;
  }) => {
    capturedUseAuth = useAuth;
    return children;
  },
}));

const EXPIRING_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 2 * 60);
const REUSABLE_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
const LONG_LIVED_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 2 * 60 * 60);

function setAuthState(overrides: Record<string, unknown>) {
  mockAuthState = {
    isLoading: false,
    isAuthenticated: true,
    user: { id_token: EXPIRING_TOKEN },
    signinSilent: mockSigninSilent,
    ...overrides,
  };
}

beforeEach(() => {
  setAuthState({});
  mockSigninSilent.mockReset();
  capturedUseAuth = null;
});

function renderUseAuth() {
  renderHook(() => null, {
    wrapper: ({ children }) => (
      <ConvexProviderWithHerculesAuth client={{} as never}>
        {children}
      </ConvexProviderWithHerculesAuth>
    ),
  });
  if (!capturedUseAuth) {
    throw new Error("useAuth not captured");
  }
  const captured = capturedUseAuth;
  return renderHook(() => captured());
}

describe("ConvexProviderWithHerculesAuth isLoading", () => {
  it("reports isLoading false when isAuthenticated is true even if underlying isLoading is true", () => {
    setAuthState({ isLoading: true, isAuthenticated: true });

    const { result } = renderUseAuth();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("reports isLoading true when not authenticated and still loading", () => {
    setAuthState({ isLoading: true, isAuthenticated: false, user: null });

    const { result } = renderUseAuth();

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
  });
});

describe("ConvexProviderWithHerculesAuth fetchAccessToken", () => {
  it("returns the cached id token when forceRefreshToken is false", async () => {
    const { result } = renderUseAuth();

    const token = await result.current.fetchAccessToken({
      forceRefreshToken: false,
    });

    expect(token).toBe(EXPIRING_TOKEN);
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("skips refresh when the token has more than the threshold of life left", async () => {
    setAuthState({ user: { id_token: LONG_LIVED_TOKEN } });

    const { result } = renderUseAuth();

    const token = await result.current.fetchAccessToken({
      forceRefreshToken: true,
    });

    expect(token).toBe(LONG_LIVED_TOKEN);
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("reuses a ~30-minute token on forced refresh instead of rotating", async () => {
    mockSigninSilent.mockResolvedValue({ id_token: "should-not-be-used" });
    setAuthState({ user: { id_token: REUSABLE_TOKEN } });

    const { result } = renderUseAuth();

    const token = await result.current.fetchAccessToken({
      forceRefreshToken: true,
    });

    expect(token).toBe(REUSABLE_TOKEN);
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("does not rotate a second time when the token is already fresh in-lock", async () => {
    let signinCalls = 0;
    mockSigninSilent.mockImplementation(() => {
      signinCalls += 1;
      return Promise.resolve({ id_token: "rotated-token" });
    });
    setAuthState({ user: { id_token: REUSABLE_TOKEN } });

    const { result } = renderUseAuth();

    await act(async () => {
      const [a, b, c] = await Promise.all([
        result.current.fetchAccessToken({ forceRefreshToken: true }),
        result.current.fetchAccessToken({ forceRefreshToken: true }),
        result.current.fetchAccessToken({ forceRefreshToken: true }),
      ]);
      expect(a).toBe(REUSABLE_TOKEN);
      expect(b).toBe(REUSABLE_TOKEN);
      expect(c).toBe(REUSABLE_TOKEN);
    });

    expect(signinCalls).toBe(0);
  });

  it("calls signinSilent and returns the refreshed token when forceRefreshToken is true", async () => {
    mockSigninSilent.mockResolvedValue({ id_token: "fresh-token" });

    const { result } = renderUseAuth();

    let token: string | null = null;
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("returns null and logs when signinSilent throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSigninSilent.mockRejectedValue(new Error("refresh failed"));

    const { result } = renderUseAuth();

    let token: string | null = "unset";
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("returns null when signinSilent resolves without a user", async () => {
    mockSigninSilent.mockResolvedValue(null);

    const { result } = renderUseAuth();

    let token: string | null = "unset";
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent forceRefreshToken calls into a single signinSilent", async () => {
    let resolveSilent: ((value: { id_token: string }) => void) | null = null;
    mockSigninSilent.mockImplementation(
      () =>
        new Promise<{ id_token: string }>((resolve) => {
          resolveSilent = resolve;
        }),
    );

    const { result } = renderUseAuth();

    let firstToken: string | null = null;
    let secondToken: string | null = null;
    let thirdToken: string | null = null;

    await act(async () => {
      const first = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
      const second = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
      const third = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });

      resolveSilent?.({ id_token: "fresh-token" });

      [firstToken, secondToken, thirdToken] = await Promise.all([first, second, third]);
    });

    expect(firstToken).toBe("fresh-token");
    expect(secondToken).toBe("fresh-token");
    expect(thirdToken).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("allows a new refresh after the in-flight refresh settles", async () => {
    mockSigninSilent
      .mockResolvedValueOnce({ id_token: "first-fresh" })
      .mockResolvedValueOnce({ id_token: "second-fresh" });

    const { result } = renderUseAuth();

    let firstToken: string | null = null;
    let secondToken: string | null = null;

    await act(async () => {
      firstToken = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });
    await act(async () => {
      secondToken = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(firstToken).toBe("first-fresh");
    expect(secondToken).toBe("second-fresh");
    expect(mockSigninSilent).toHaveBeenCalledTimes(2);
  });

  it("keeps fetchAccessToken stable across silent renewal of the same subject", async () => {
    const FIRST_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    const SECOND_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 60 * 60);
    setAuthState({
      user: {
        id_token: FIRST_TOKEN,
        profile: { iss: "https://issuer.example", sub: "alice" },
      },
    });

    const { result, rerender } = renderUseAuth();
    const firstFetch = result.current.fetchAccessToken;

    expect(await result.current.fetchAccessToken({ forceRefreshToken: false })).toBe(FIRST_TOKEN);

    setAuthState({
      user: {
        id_token: SECOND_TOKEN,
        profile: { iss: "https://issuer.example", sub: "alice" },
      },
    });
    rerender();

    expect(result.current.fetchAccessToken).toBe(firstFetch);
    expect(await result.current.fetchAccessToken({ forceRefreshToken: false })).toBe(SECOND_TOKEN);
  });

  it("re-identifies fetchAccessToken when the subject changes", async () => {
    const ALICE_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    const BOB_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    setAuthState({
      user: { id_token: ALICE_TOKEN, profile: { sub: "alice" } },
    });

    const { result, rerender } = renderUseAuth();
    const aliceFetch = result.current.fetchAccessToken;

    setAuthState({
      user: { id_token: BOB_TOKEN, profile: { sub: "bob" } },
    });
    rerender();

    expect(await result.current.fetchAccessToken({ forceRefreshToken: false })).toBe(BOB_TOKEN);
    expect(result.current.fetchAccessToken).not.toBe(aliceFetch);
  });

  it("re-identifies fetchAccessToken when the issuer changes", async () => {
    const FIRST_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    const SECOND_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    setAuthState({
      user: {
        id_token: FIRST_TOKEN,
        profile: { iss: "https://issuer-a.example", sub: "shared-sub" },
      },
    });

    const { result, rerender } = renderUseAuth();
    const firstFetch = result.current.fetchAccessToken;

    setAuthState({
      user: {
        id_token: SECOND_TOKEN,
        profile: { iss: "https://issuer-b.example", sub: "shared-sub" },
      },
    });
    rerender();

    expect(result.current.fetchAccessToken).not.toBe(firstFetch);
    expect(await result.current.fetchAccessToken({ forceRefreshToken: false })).toBe(SECOND_TOKEN);
  });
});
