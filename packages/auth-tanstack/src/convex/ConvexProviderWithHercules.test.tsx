// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, configure } from "@testing-library/react";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules.js";

configure({ reactStrictMode: true });

const mockGetIdToken = vi.fn();
const mockRefresh = vi.fn();

let mockAuthState: Record<string, unknown> = {};
let mockIdTokenState: Record<string, unknown> = {};

vi.mock("../client/HerculesAuthProvider", () => ({
  useAuth: () => mockAuthState,
}));

vi.mock("../client/useIdToken", () => ({
  useIdToken: () => mockIdTokenState,
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

const USER = { id: "user_1", email: "a@b.c" };
const TOKEN = "header.payload.sig";

interface StateOverrides {
  user?: unknown;
  loading?: boolean;
  idToken?: string | undefined;
  tokenLoading?: boolean;
}

function setState(overrides: StateOverrides = {}) {
  const { user = USER as unknown, loading = false, tokenLoading = false } = overrides;
  // Not a destructuring default: `{ idToken: undefined }` is exactly the case
  // under test, and a default would silently turn it back into a token.
  const idToken = "idToken" in overrides ? overrides.idToken : TOKEN;
  mockAuthState = { user, loading };
  mockIdTokenState = {
    idToken,
    loading: tokenLoading,
    error: null,
    getIdToken: mockGetIdToken,
    refresh: mockRefresh,
  };
}

beforeEach(() => {
  setState();
  mockGetIdToken.mockReset().mockResolvedValue(TOKEN);
  mockRefresh.mockReset().mockResolvedValue(TOKEN);
  capturedUseAuth = null;
});

function renderBridge() {
  return renderHook(() => capturedUseAuth?.(), {
    wrapper: ({ children }) => (
      <ConvexProviderWithHerculesAuth client={{} as never}>
        {children}
      </ConvexProviderWithHerculesAuth>
    ),
  });
}

describe("ConvexProviderWithHerculesAuth", () => {
  it("reports unauthenticated while a seeded session has no token yet", () => {
    setState({ idToken: undefined, tokenLoading: true });
    const { result } = renderBridge();
    expect(result.current?.isAuthenticated).toBe(false);
    expect(result.current?.isLoading).toBe(true);
  });

  it("reports authenticated once the token lands", () => {
    const { result } = renderBridge();
    expect(result.current?.isAuthenticated).toBe(true);
    expect(result.current?.isLoading).toBe(false);
  });

  it("changes identity when the token arrives so Convex re-requests it", () => {
    setState({ idToken: undefined, tokenLoading: true });
    const { result, rerender } = renderBridge();
    const before = result.current;

    setState({ idToken: TOKEN });
    rerender();

    expect(before).not.toBe(result.current);
    expect(before?.isAuthenticated).toBe(false);
    expect(result.current?.isAuthenticated).toBe(true);
  });

  it("stays out of the loading state during a background refresh", () => {
    setState({ tokenLoading: true });
    const { result } = renderBridge();
    expect(result.current?.isAuthenticated).toBe(true);
    expect(result.current?.isLoading).toBe(false);
  });

  it("reports unauthenticated when signed out", () => {
    setState({ user: null, idToken: undefined });
    const { result } = renderBridge();
    expect(result.current?.isAuthenticated).toBe(false);
    expect(result.current?.isLoading).toBe(false);
  });

  it("resolves null instead of rejecting when the token fetch throws", async () => {
    mockGetIdToken.mockRejectedValue(new Error("network"));
    const { result } = renderBridge();

    await act(async () => {
      await expect(
        result.current?.fetchAccessToken({ forceRefreshToken: false }),
      ).resolves.toBeNull();
    });
  });

  // Like Convex's own WorkOS bridge, `forceRefreshToken` is ignored: the token
  // store already refreshes ahead of expiry, and Convex forces a refetch right
  // after confirming the cached token on every page load. Spending a refresh
  // grant there is wasteful, and an empty answer would be read as "signed out"
  // and latch the client unauthenticated for the rest of the page.
  it("answers a forced refresh from the token store instead of a refresh grant", async () => {
    const { result } = renderBridge();

    await act(async () => {
      await expect(result.current?.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        TOKEN,
      );
    });
    expect(mockGetIdToken).toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("resolves null when the token store has nothing", async () => {
    mockGetIdToken.mockResolvedValue(undefined);
    const { result } = renderBridge();

    await act(async () => {
      await expect(
        result.current?.fetchAccessToken({ forceRefreshToken: true }),
      ).resolves.toBeNull();
    });
  });
});
