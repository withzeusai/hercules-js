import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor, configure } from "@testing-library/react";
import { useAuthCallback } from "./auth-callback-hook.js";

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

function setAuthState(overrides: Partial<typeof mockAuthState>) {
  mockAuthState = { ...mockAuthState, ...overrides };
}

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

      const { result, rerender } = renderHook(() =>
        useAuthCallback({
          isBackendAuthenticated: true,
          onSync,
        }),
      );

      expect(result.current.status).toBe("processing-oauth");

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
        const { result } = renderHook(() =>
          useAuthCallback({ timeoutMs: 5000 }),
        );

        expect(result.current.status).toBe("processing-oauth");

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(result.current.status).toBe("error");
        expect(result.current.error).toBe(
          "Authentication timed out. Please try again.",
        );
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

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(result.current.status).toBe("success");

        act(() => {
          vi.advanceTimersByTime(10000);
        });

        expect(result.current.status).toBe("success");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses a single wall-clock deadline across status transitions", async () => {
      vi.useFakeTimers();

      try {
        const onSync = vi.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 10000);
            }),
        );

        setAuthState({ isLoading: false, isAuthenticated: true });

        const { result } = renderHook(() =>
          useAuthCallback({
            isBackendAuthenticated: true,
            onSync,
            timeoutMs: 5000,
          }),
        );

        // Let status move through waiting-backend -> syncing.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(result.current.status).toBe("syncing");

        // Advance past the original 5s deadline; timer should not have reset.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });

        expect(result.current.status).toBe("error");
        expect(result.current.error).toBe(
          "Authentication timed out. Please try again.",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("OIDC errors", () => {
    it("transitions to error when OIDC reports an error and is not authenticated", () => {
      setAuthState({ error: new Error("OIDC failed") });

      const { result } = renderHook(() => useAuthCallback());

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("OIDC failed");
    });

    it("treats OIDC error alongside authenticated user as success path (StrictMode double-init)", async () => {
      const onSync = vi.fn().mockResolvedValue(undefined);

      setAuthState({
        isLoading: false,
        isAuthenticated: true,
        error: new Error("code already used"),
      });

      const { result } = renderHook(() =>
        useAuthCallback({
          isBackendAuthenticated: true,
          onSync,
        }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onSync).toHaveBeenCalledOnce();
    });
  });

  describe("no auth params", () => {
    it("calls onNoAuthParams when no auth params and not authenticated", () => {
      mockHasAuthParams = false;
      setAuthState({ isLoading: false, isAuthenticated: false });

      const onNoAuthParams = vi.fn();

      renderHook(() => useAuthCallback({ onNoAuthParams }));

      expect(onNoAuthParams).toHaveBeenCalledOnce();
    });

    it("does not call onNoAuthParams more than once across rerenders", () => {
      mockHasAuthParams = false;
      setAuthState({ isLoading: false, isAuthenticated: false });

      const onNoAuthParams = vi.fn();

      const { rerender } = renderHook(() =>
        useAuthCallback({ onNoAuthParams }),
      );

      rerender();
      rerender();

      expect(onNoAuthParams).toHaveBeenCalledOnce();
    });

    it("fires onNoAuthParams when it becomes available on a later rerender", () => {
      mockHasAuthParams = false;
      setAuthState({ isLoading: false, isAuthenticated: false });

      const onNoAuthParams = vi.fn();

      const { rerender } = renderHook(
        ({ cb }: { cb?: () => void }) => useAuthCallback({ onNoAuthParams: cb }),
        { initialProps: { cb: undefined as (() => void) | undefined } },
      );

      expect(onNoAuthParams).not.toHaveBeenCalled();

      rerender({ cb: onNoAuthParams });

      expect(onNoAuthParams).toHaveBeenCalledOnce();
    });
  });

  describe("benign OIDC settled state", () => {
    it("does not declare failure when OIDC briefly settles unauthenticated with no error", async () => {
      vi.useFakeTimers();

      try {
        const { result, rerender } = renderHook(() =>
          useAuthCallback({ timeoutMs: 10000 }),
        );

        setAuthState({ isLoading: false, isAuthenticated: false });
        rerender();

        // Let any pending microtasks settle.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        // Should still be processing — no spurious "cancelled or failed".
        expect(result.current.status).toBe("processing-oauth");

        // Recovery: OIDC authenticates after the transient state.
        setAuthState({ isLoading: false, isAuthenticated: true });
        rerender();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(result.current.status).toBe("success");
      } finally {
        vi.useRealTimers();
      }
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

      expect(result.current.status).toBe("waiting-backend");
      expect(onSync).not.toHaveBeenCalled();

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

      const { result } = renderHook(() =>
        useAuthCallback({ isBackendAuthenticated: true }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });
    });
  });

  describe("late-bound onSuccess", () => {
    it("fires onSuccess when it becomes available after status already reached success", async () => {
      const onSync = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();

      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result, rerender } = renderHook(
        ({ cb }: { cb?: () => void }) =>
          useAuthCallback({
            isBackendAuthenticated: true,
            onSync,
            onSuccess: cb,
          }),
        { initialProps: { cb: undefined as (() => void) | undefined } },
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onSuccess).not.toHaveBeenCalled();

      rerender({ cb: onSuccess });

      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  describe("callback identity churn", () => {
    it("fires onSuccess exactly once even when parent re-renders with a new reference", async () => {
      setAuthState({ isLoading: false, isAuthenticated: true });

      const calls: number[] = [];
      let counter = 0;

      const { result, rerender } = renderHook(() => {
        const n = ++counter;
        return useAuthCallback({
          isBackendAuthenticated: true,
          onSuccess: () => {
            calls.push(n);
          },
        });
      });

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      rerender();
      rerender();
      rerender();

      expect(calls).toHaveLength(1);
    });
  });
});
