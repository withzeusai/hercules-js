import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, configure } from "@testing-library/react";
import { useAuth } from "./use-auth.js";

configure({ reactStrictMode: true });

// ---- Mocks ----

const mockSignoutRedirect = vi.fn();
const mockSigninRedirect = vi.fn();
const mockRemoveUser = vi.fn();
const mockGetEndSessionEndpoint = vi.fn();

const mockUserManager = {
  metadataService: {
    getEndSessionEndpoint: mockGetEndSessionEndpoint,
  },
};

let mockAuthState: Record<string, unknown> = {};

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
}));

vi.mock("./HerculesAuthProvider", () => ({
  useHerculesAuthProvider: () => ({ userManager: mockUserManager }),
}));

// ---- Helpers ----

function setAuthState(overrides: Record<string, unknown>) {
  mockAuthState = {
    isLoading: false,
    isAuthenticated: true,
    signoutRedirect: mockSignoutRedirect,
    signinRedirect: mockSigninRedirect,
    removeUser: mockRemoveUser,
    ...overrides,
  };
}

// ---- Tests ----

beforeEach(() => {
  setAuthState({});
  mockSignoutRedirect.mockReset();
  mockSigninRedirect.mockReset();
  mockRemoveUser.mockReset();
  mockGetEndSessionEndpoint.mockReset();
});

describe("useAuth", () => {
  it("returns the underlying auth state with a signout method", () => {
    const { result } = renderHook(() => useAuth());

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(typeof result.current.signout).toBe("function");
    expect(typeof result.current.signin).toBe("function");
  });

  it("spreads all properties from the oidc auth context", () => {
    setAuthState({ isAuthenticated: false, isLoading: true });

    const { result } = renderHook(() => useAuth());

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  describe("signout", () => {
    it("calls signoutRedirect when end session endpoint exists", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue(
        "https://auth.example.com/logout",
      );
      mockSignoutRedirect.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockGetEndSessionEndpoint).toHaveBeenCalled();
      expect(mockSignoutRedirect).toHaveBeenCalledOnce();
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    it("calls removeUser when end session endpoint is null", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue(null);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockGetEndSessionEndpoint).toHaveBeenCalled();
      expect(mockSignoutRedirect).not.toHaveBeenCalled();
      expect(mockRemoveUser).toHaveBeenCalledOnce();
    });

    it("calls removeUser when end session endpoint is undefined", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockSignoutRedirect).not.toHaveBeenCalled();
      expect(mockRemoveUser).toHaveBeenCalledOnce();
    });
  });

  describe("signin", () => {
    it("calls signinRedirect", async () => {
      mockSigninRedirect.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signin();
      });

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
    });
  });

  describe("memoization", () => {
    it("returns a stable signout reference across rerenders with same deps", () => {
      const { result, rerender } = renderHook(() => useAuth());

      const firstSignout = result.current.signout;
      rerender();
      const secondSignout = result.current.signout;

      expect(firstSignout).toBe(secondSignout);
    });

    it("returns a stable signin reference across rerenders with same deps", () => {
      const { result, rerender } = renderHook(() => useAuth());

      const firstSignin = result.current.signin;
      rerender();
      const secondSignin = result.current.signin;

      expect(firstSignin).toBe(secondSignin);
    });
  });
});
