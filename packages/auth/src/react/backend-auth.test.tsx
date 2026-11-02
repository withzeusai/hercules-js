import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBackendAuth } from "./backend-auth.js";

function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
}

const LONG_LIVED_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 2 * 60 * 60);
const EXPIRING_TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 30 * 60);
const mockSigninSilent = vi.fn();
let mockAuthState: Record<string, unknown> = {};

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
}));

beforeEach(() => {
  mockSigninSilent.mockReset();
  mockAuthState = {
    isLoading: false,
    isAuthenticated: true,
    user: { id_token: LONG_LIVED_TOKEN, profile: { iss: "https://auth.example", sub: "ada" } },
    signinSilent: mockSigninSilent,
  };
});

// The Convex bridge's tests cover the refresh rules; these, that the hook works on its
// own, as a backend's auth provider (Fundulus's FundulusProviderWithAuth) calls it.
describe("useBackendAuth", () => {
  it("says the user is signed in and hands over their ID token", async () => {
    const { result } = renderHook(() => useBackendAuth());
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
    await expect(result.current.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
      LONG_LIVED_TOKEN,
    );
    await expect(result.current.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
      LONG_LIVED_TOKEN,
    );
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("refreshes a token close to expiring when asked to", async () => {
    mockAuthState = {
      ...mockAuthState,
      user: { id_token: EXPIRING_TOKEN, profile: { iss: "https://auth.example", sub: "ada" } },
    };
    mockSigninSilent.mockResolvedValue({ id_token: LONG_LIVED_TOKEN });
    const { result } = renderHook(() => useBackendAuth());
    await expect(result.current.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
      LONG_LIVED_TOKEN,
    );
    expect(mockSigninSilent).toHaveBeenCalledTimes(1);
  });

  it("keeps its fetcher while the user stays, and is signed out without one", () => {
    const { result, rerender } = renderHook(() => useBackendAuth());
    const first = result.current.fetchAccessToken;
    rerender();
    expect(result.current.fetchAccessToken).toBe(first);
    mockAuthState = { ...mockAuthState, isAuthenticated: false, user: null };
    rerender();
    expect(result.current.isAuthenticated).toBe(false);
  });
});
