import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor, configure } from "@testing-library/react";
import { useAuthCallback } from "./auth-callback-hook.js";

// Run every test under StrictMode so the double-mount cycle
// (mount → unmount → remount) is always exercised.
configure({ reactStrictMode: true });

// ---- Mocks ----

const mockSigninRedirect = vi.fn();

let mockAuthState = {
  isLoading: true,
  isAuthenticated: false,
  error: undefined as Error | undefined,
  signinRedirect: mockSigninRedirect,
};

let mockHasAuthParams = true;

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
  hasAuthParams: () => mockHasAuthParams,
}));

vi.mock("convex/values", () => ({
  ConvexError: class ConvexError extends Error {
    data: unknown;
    constructor(data: unknown) {
      super("ConvexError");
      this.data = data;
    }
  },
}));

// ---- Helpers ----

function setAuthState(overrides: Partial<typeof mockAuthState>) {
  mockAuthState = { ...mockAuthState, ...overrides };
}

// ---- Tests ----

beforeEach(() => {
  mockAuthState = {
    isLoading: true,
    isAuthenticated: false,
    error: undefined,
    signinRedirect: mockSigninRedirect,
  };
  mockHasAuthParams = true;
  mockSigninRedirect.mockReset();
});

describe("useAuthCallback", () => {
  describe("initial state", () => {
    it("starts in processing-oauth status", () => {
      const { result } = renderHook(() => useAuthCallback());
      expect(result.current.status).toBe("processing-oauth");
      expect(result.current.isLoading).toBe(true);
      expect(result.current.isSuccess).toBe(false);
      expect(result.current.isError).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("happy path (full flow)", () => {
    it("reaches success when OIDC authenticates and backend is ready", async () => {
      const onSync = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();

      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() =>
        useAuthCallback({
          isBackendAuthenticated: true,
          onSync,
          onSuccess,
        }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onSync).toHaveBeenCalledOnce();
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isSuccess).toBe(true);
    });

    it("transitions through waiting-backend when OIDC finishes after mount", async () => {
      const onSync = vi.fn().mockResolvedValue(undefined);

      // Start with OIDC still loading
      const { result, rerender } = renderHook(() =>
        useAuthCallback({
          isBackendAuthenticated: true,
          onSync,
        }),
      );

      expect(result.current.status).toBe("processing-oauth");

      // OIDC finishes
      setAuthState({ isLoading: false, isAuthenticated: true });
      rerender();

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onSync).toHaveBeenCalledOnce();
    });
  });

  describe("timeout", () => {
    it("errors after timeout when stuck", () => {
      vi.useFakeTimers();

      try {
        const { result } = renderHook(() => useAuthCallback({ timeoutMs: 5000 }));

        expect(result.current.status).toBe("processing-oauth");

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(result.current.status).toBe("error");
        expect(result.current.error).toBe("Authentication timed out. Please try again.");
        expect(result.current.isError).toBe(true);
        expect(result.current.isLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not timeout after reaching success", async () => {
      vi.useFakeTimers();

      try {
        const onSync = vi.fn().mockResolvedValue(undefined);

        setAuthState({ isLoading: false, isAuthenticated: true });

        const { result } = renderHook(() =>
          useAuthCallback({
            isBackendAuthenticated: true,
            onSync,
            timeoutMs: 5000,
          }),
        );

        // Flush microtasks for async sync to complete
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(result.current.status).toBe("success");

        // Advance past timeout — should still be success, not error
        act(() => {
          vi.advanceTimersByTime(10000);
        });

        expect(result.current.status).toBe("success");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("OIDC errors", () => {
    it("transitions to error when OIDC reports an error", () => {
      setAuthState({ error: new Error("OIDC failed") });

      const { result } = renderHook(() => useAuthCallback());

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("OIDC failed");
    });
  });

  describe("missing OIDC state", () => {
    const missingStateError = () =>
      Object.assign(new Error("No matching state found in storage"), {
        source: "signinCallback",
      });

    beforeEach(() => {
      window.sessionStorage.clear();
      window.history.replaceState({}, "", "/auth/callback?code=orphan&state=dead");
    });

    it("strips the orphaned code and restarts sign-in once", () => {
      setAuthState({ isLoading: false, error: missingStateError() });

      const { result } = renderHook(() => useAuthCallback());

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
      expect(window.location.search).toBe("");
      expect(window.sessionStorage.getItem("hercules-auth:missing-state-retry")).toBe("1");
      expect(result.current.status).toBe("processing-oauth");
    });

    it("shows the error when the restarted sign-in also misses state", () => {
      window.sessionStorage.setItem("hercules-auth:missing-state-retry", "1");
      setAuthState({ isLoading: false, error: missingStateError() });

      const { result } = renderHook(() => useAuthCallback());

      expect(mockSigninRedirect).not.toHaveBeenCalled();
      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("No matching state found in storage");
    });

    it("shows the error when the restarted sign-in fails to start", () => {
      setAuthState({ isLoading: false, error: missingStateError() });

      const { result, rerender } = renderHook(() => useAuthCallback());

      setAuthState({
        error: Object.assign(new Error("Network down"), { source: "signinRedirect" }),
      });
      rerender();

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("Network down");
    });

    it("does not restart sign-in without an authorization code", () => {
      window.history.replaceState({}, "", "/auth/callback?error=access_denied&state=dead");
      setAuthState({ isLoading: false, error: missingStateError() });

      const { result } = renderHook(() => useAuthCallback());

      expect(mockSigninRedirect).not.toHaveBeenCalled();
      expect(result.current.status).toBe("error");
    });

    it("does not restart sign-in for other callback errors", () => {
      setAuthState({
        isLoading: false,
        error: Object.assign(new Error("invalid_grant"), { source: "signinCallback" }),
      });

      const { result } = renderHook(() => useAuthCallback());

      expect(mockSigninRedirect).not.toHaveBeenCalled();
      expect(result.current.status).toBe("error");
      expect(window.location.search).toBe("?code=orphan&state=dead");
    });
  });

  describe("no auth params", () => {
    it("calls onNoAuthParams when no auth params and not authenticated", () => {
      mockHasAuthParams = false;
      setAuthState({ isLoading: false, isAuthenticated: false });

      const onNoAuthParams = vi.fn();

      renderHook(() => useAuthCallback({ onNoAuthParams }));

      expect(onNoAuthParams).toHaveBeenCalled();
    });
  });

  describe("sync errors", () => {
    it("transitions to error when onSync throws", async () => {
      const onSync = vi.fn().mockRejectedValue(new Error("Sync boom"));

      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() =>
        useAuthCallback({
          isBackendAuthenticated: true,
          onSync,
        }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("error");
      });

      expect(result.current.error).toBe("Sync boom");
    });
  });

  describe("waiting for backend", () => {
    it("stays in waiting-backend until isBackendAuthenticated is true", async () => {
      const onSync = vi.fn().mockResolvedValue(undefined);

      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result, rerender } = renderHook(
        ({ backendAuth }: { backendAuth: boolean }) =>
          useAuthCallback({
            isBackendAuthenticated: backendAuth,
            onSync,
          }),
        { initialProps: { backendAuth: false } },
      );

      // Should be in waiting-backend (OIDC done, but backend not ready)
      expect(result.current.status).toBe("waiting-backend");
      expect(onSync).not.toHaveBeenCalled();

      // Backend becomes authenticated
      rerender({ backendAuth: true });

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onSync).toHaveBeenCalledOnce();
    });
  });

  describe("retry", () => {
    it("calls signinRedirect on retry", async () => {
      mockSigninRedirect.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuthCallback());

      await act(async () => {
        await result.current.retry();
      });

      expect(mockSigninRedirect).toHaveBeenCalledOnce();
    });
  });

  describe("no onSync provided", () => {
    it("goes straight to success when onSync is omitted", async () => {
      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() => useAuthCallback({ isBackendAuthenticated: true }));

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });
    });
  });
});
