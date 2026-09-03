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

  // Convex forces a refresh right after confirming the cached token. A refresh
  // comes back empty when the provider issued no refresh token (no
  // `offline_access`) or the grant failed transiently — while the session is
  // still valid. Convex reads an empty answer as "signed out" and latches the
  // client unauthenticated, so the bridge must hand back the current token.
  it("falls back to the current ID token when a forced refresh returns nothing", async () => {
    mockRefresh.mockResolvedValue(undefined);
    const { result } = renderBridge();

    await act(async () => {
      await expect(result.current?.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        TOKEN,
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockGetIdToken).toHaveBeenCalled();
  });

  it("falls back to the current ID token when a forced refresh rejects", async () => {
    mockRefresh.mockRejectedValue(new Error("refresh grant failed"));
    const { result } = renderBridge();

    await act(async () => {
      await expect(result.current?.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        TOKEN,
      );
    });
  });

  it("resolves null when both the forced refresh and the current token are empty", async () => {
    mockRefresh.mockResolvedValue(undefined);
    mockGetIdToken.mockResolvedValue(undefined);
    const { result } = renderBridge();

    await act(async () => {
      await expect(
        result.current?.fetchAccessToken({ forceRefreshToken: true }),
      ).resolves.toBeNull();
    });
  });

  it("forces a refresh when Convex asks for one", async () => {
    const { result } = renderBridge();

    await act(async () => {
      await expect(result.current?.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        TOKEN,
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockGetIdToken).not.toHaveBeenCalled();
  });
});
