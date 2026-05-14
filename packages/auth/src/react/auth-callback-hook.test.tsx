import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor, configure } from "@testing-library/react";
import { useAuthCallback } from "./auth-callback-hook.js";
import {
  __resetDiagnosticsState,
  type AuthDiagnosticEvent,
} from "./diagnostics.js";

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

const mockGetIssuer = vi.fn().mockResolvedValue(undefined);
const mockGetTokenEndpoint = vi.fn().mockResolvedValue(undefined);
const mockUserManager = {
  metadataService: {
    getIssuer: mockGetIssuer,
    getTokenEndpoint: mockGetTokenEndpoint,
  },
};

const defaultProviderContext = {
  userManager: mockUserManager,
  authority: "https://issuer.example.com",
  clientId: "client_xyz",
  redirectUri: "https://app.example.com/auth/callback",
  diagnostics: { enabled: false } as unknown,
  storageAvailable: true,
};
let mockProviderContext: typeof defaultProviderContext = defaultProviderContext;

vi.mock("./HerculesAuthProvider", () => ({
  useHerculesAuthProvider: () => mockProviderContext,
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
  mockGetIssuer.mockResolvedValue("https://issuer.example.com");
  mockGetTokenEndpoint.mockResolvedValue(
    "https://issuer.example.com/oauth/token",
  );
  mockProviderContext = defaultProviderContext;
  __resetDiagnosticsState();
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
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

      const { result } = renderHook(() =>
        useAuthCallback({ isBackendAuthenticated: true }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });
    });
  });

  describe("diagnostics", () => {
    it("reports oidc-error when OIDC reports an error", async () => {
      const onDiagnostic = vi.fn();
      mockProviderContext = {
        ...defaultProviderContext,
        diagnostics: { onDiagnostic, reportToHercules: false },
      };

      setAuthState({ error: new Error("OIDC failed") });

      renderHook(() => useAuthCallback());

      await waitFor(() => {
        expect(onDiagnostic).toHaveBeenCalled();
      });
      const event = onDiagnostic.mock.calls[0]![0] as AuthDiagnosticEvent;
      expect(event.phase).toBe("oidc-error");
      expect(event.errorClass).toBe("oidc_provider_error");
    });

    it("reports callback-timeout after timeout fires", async () => {
      vi.useFakeTimers();
      try {
        const onDiagnostic = vi.fn();
        mockProviderContext = {
          ...defaultProviderContext,
          diagnostics: { onDiagnostic, reportToHercules: false },
        };

        renderHook(() => useAuthCallback({ timeoutMs: 5000 }));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });

        expect(onDiagnostic).toHaveBeenCalled();
        const event = onDiagnostic.mock.calls[0]![0] as AuthDiagnosticEvent;
        expect(event.phase).toBe("callback-timeout");
        expect(event.errorClass).toBe("callback_timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports backend-sync-failed when onSync throws", async () => {
      const onDiagnostic = vi.fn();
      mockProviderContext = {
        ...defaultProviderContext,
        diagnostics: { onDiagnostic, reportToHercules: false },
      };

      const onSync = vi.fn().mockRejectedValue(new Error("backend exploded"));
      setAuthState({ isLoading: false, isAuthenticated: true });

      renderHook(() =>
        useAuthCallback({ isBackendAuthenticated: true, onSync }),
      );

      await waitFor(() => {
        expect(onDiagnostic).toHaveBeenCalled();
      });
      const event = onDiagnostic.mock.calls[0]![0] as AuthDiagnosticEvent;
      expect(event.phase).toBe("backend-sync-failed");
      expect(event.errorClass).toBe("backend_sync_failed");
    });

    it("reports callback-not-authenticated after the OIDC callback stays unauthenticated", async () => {
      vi.useFakeTimers();
      try {
        const onDiagnostic = vi.fn();
        mockProviderContext = {
          ...defaultProviderContext,
          diagnostics: { onDiagnostic, reportToHercules: false },
        };

        setAuthState({ isLoading: false, isAuthenticated: false });

        renderHook(() => useAuthCallback());

        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });

        expect(onDiagnostic).toHaveBeenCalled();
        const event = onDiagnostic.mock.calls[0]![0] as AuthDiagnosticEvent;
        expect(event.phase).toBe("callback-not-authenticated");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the auth attempt id on success", async () => {
      const onDiagnostic = vi.fn();
      mockProviderContext = {
        ...defaultProviderContext,
        diagnostics: { onDiagnostic, reportToHercules: false },
      };

      // Seed an attempt id like a real sign-in would.
      sessionStorage.setItem("_hrc_auth_attempt", "att_existing");

      setAuthState({ isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() =>
        useAuthCallback({ isBackendAuthenticated: true }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(sessionStorage.getItem("_hrc_auth_attempt")).toBeNull();
    });

    it("does not report diagnostics on the happy path", async () => {
      const onDiagnostic = vi.fn();
      mockProviderContext = {
        ...defaultProviderContext,
        diagnostics: { onDiagnostic, reportToHercules: false },
      };

      setAuthState({ isLoading: false, isAuthenticated: true });

      const onSync = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAuthCallback({ isBackendAuthenticated: true, onSync }),
      );

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      expect(onDiagnostic).not.toHaveBeenCalled();
    });
  });
});
