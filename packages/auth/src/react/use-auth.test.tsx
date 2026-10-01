import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, configure } from "@testing-library/react";
import { useAuth } from "./use-auth.js";

configure({ reactStrictMode: true });

// ---- Mocks ----

const mockSignoutRedirect = vi.fn();
const mockSigninRedirect = vi.fn();
const mockRemoveUser = vi.fn();
const mockGetEndSessionEndpoint = vi.fn();
const mockRevokeTokens = vi.fn();

const mockUserManager = {
  metadataService: {
    getEndSessionEndpoint: mockGetEndSessionEndpoint,
  },
  settings: { revokeTokensOnSignout: false },
  revokeTokens: mockRevokeTokens,
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
  mockRevokeTokens.mockReset();
  mockUserManager.settings.revokeTokensOnSignout = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function simulateFrame() {
  vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
}

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
      mockGetEndSessionEndpoint.mockResolvedValue("https://auth.example.com/logout");
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

    it("removes the user locally instead of navigating when framed", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue("https://auth.example.com/logout");
      simulateFrame();

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockSignoutRedirect).not.toHaveBeenCalled();
      expect(mockRevokeTokens).not.toHaveBeenCalled();
      expect(mockRemoveUser).toHaveBeenCalledOnce();
    });

    it("treats an inaccessible top window as framed", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue("https://auth.example.com/logout");
      vi.spyOn(window, "top", "get").mockImplementation(() => {
        throw new DOMException("Blocked a frame", "SecurityError");
      });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockSignoutRedirect).not.toHaveBeenCalled();
      expect(mockRemoveUser).toHaveBeenCalledOnce();
    });

    it("revokes tokens before removing the user when framed and configured to revoke", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue("https://auth.example.com/logout");
      mockUserManager.settings.revokeTokensOnSignout = true;
      simulateFrame();

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockSignoutRedirect).not.toHaveBeenCalled();
      expect(mockRevokeTokens).toHaveBeenCalledOnce();
      expect(mockRemoveUser).toHaveBeenCalledOnce();
      expect(mockRevokeTokens.mock.invocationCallOrder[0]).toBeLessThan(
        mockRemoveUser.mock.invocationCallOrder[0]!,
      );
    });

    it("keeps redirect sign-out at the top level when configured to revoke", async () => {
      mockGetEndSessionEndpoint.mockResolvedValue("https://auth.example.com/logout");
      mockUserManager.settings.revokeTokensOnSignout = true;

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signout();
      });

      expect(mockSignoutRedirect).toHaveBeenCalledOnce();
      expect(mockSignoutRedirect).toHaveBeenCalledWith();
      expect(mockRevokeTokens).not.toHaveBeenCalled();
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });
  });

  describe("signin", () => {
    it("passes the current URL as returnTo state by default", async () => {
      mockSigninRedirect.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signin();
      });

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
      expect(mockSigninRedirect).toHaveBeenCalledWith({
        state: {
          returnTo: window.location.pathname + window.location.search + window.location.hash,
        },
      });
    });

    it("passes an explicit returnTo as state", async () => {
      mockSigninRedirect.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signin({ returnTo: "/projects/42?tab=members" });
      });

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
      expect(mockSigninRedirect).toHaveBeenCalledWith({
        state: { returnTo: "/projects/42?tab=members" },
      });
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
