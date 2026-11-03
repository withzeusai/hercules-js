import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorResponse } from "oidc-client-ts";
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

// Token expiring in 30 minutes (within the one-hour refresh threshold).
const EXPIRING_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
// Token expiring in two hours (outside the one-hour refresh threshold).
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

  it("skips refresh when token expires more than one hour from now", async () => {
    setAuthState({ user: { id_token: LONG_LIVED_TOKEN } });

    const { result } = renderUseAuth();

    const token = await result.current.fetchAccessToken({
      forceRefreshToken: true,
    });

    expect(token).toBe(LONG_LIVED_TOKEN);
    expect(mockSigninSilent).not.toHaveBeenCalled();
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

  it("returns null when signinSilent throws", async () => {
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

describe("ConvexProviderWithHerculesAuth transient refresh failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["a network error", new TypeError("Failed to fetch")],
    ["a timeout", Object.assign(new Error("Network timed out"), { name: "ErrorTimeout" })],
    ["a 5xx", new Error("Service Unavailable (503)")],
    ["an OAuth server_error", new ErrorResponse({ error: "server_error" })],
  ])("retries after %s and returns the refreshed token", async (_label, err) => {
    mockSigninSilent.mockRejectedValueOnce(err).mockResolvedValueOnce({ id_token: "fresh-token" });
    const { result } = renderUseAuth();

    const token = result.current.fetchAccessToken({ forceRefreshToken: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await token).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledTimes(2);
  });

  it("returns null once the retries run out", async () => {
    mockSigninSilent.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderUseAuth();

    const token = result.current.fetchAccessToken({ forceRefreshToken: true });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await token).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["invalid_grant", new ErrorResponse({ error: "invalid_grant" })],
    ["a 4xx", new Error("Bad Request (400)")],
  ])("returns null on %s without retrying", async (_label, err) => {
    mockSigninSilent.mockRejectedValue(err);
    const { result } = renderUseAuth();

    expect(await result.current.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("waits for the browser to come back online before retrying", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mockSigninSilent
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ id_token: "fresh-token" });
    const { result } = renderUseAuth();

    const token = result.current.fetchAccessToken({ forceRefreshToken: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockSigninSilent).toHaveBeenCalledOnce();

    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));

    expect(await token).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledTimes(2);
  });
});
