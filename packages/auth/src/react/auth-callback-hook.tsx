"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useAuth, hasAuthParams } from "react-oidc-context";
import { ConvexError } from "convex/values";
import * as z from "zod";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import {
  clearAuthAttemptId,
  reportAuthDiagnostic,
  startAuthAttempt,
  type AuthDiagnosticPhase,
} from "./diagnostics";

const DEFAULT_TIMEOUT_MS = 20000; // 20 second timeout

const convexErrorSchema = z.object({
  message: z.string(),
});

/**
 * Authentication callback status states
 * @public
 */
export type AuthCallbackStatus =
  | "processing-oauth" // OIDC is processing the callback
  | "waiting-backend" // OIDC authenticated, waiting for backend
  | "syncing" // Syncing user with backend (e.g., creating user record)
  | "success" // All done
  | "error"; // Something went wrong

/**
 * Options for the useAuthCallback hook
 * @public
 */
export interface UseAuthCallbackOptions {
  /**
   * Timeout in milliseconds before the callback is considered failed.
   * @default 20000
   */
  timeoutMs?: number;

  /**
   * Whether the backend (e.g., Convex) is authenticated.
   * The hook will wait for this to be true before calling onSync.
   */
  isBackendAuthenticated?: boolean;

  /**
   * Called when the backend is authenticated and ready to sync.
   * Use this to create/update the user in your backend.
   * Return a promise that resolves when sync is complete.
   */
  onSync?: () => Promise<void>;

  /**
   * Called when authentication is successful and sync is complete.
   * Use this to redirect the user.
   */
  onSuccess?: () => void;

  /**
   * Called when OIDC is not authenticated and there are no auth params.
   * This typically means the user navigated directly to the callback page.
   * Use this to redirect them away.
   */
  onNoAuthParams?: () => void;
}

/**
 * Return type for the useAuthCallback hook
 * @public
 */
export interface UseAuthCallbackResult {
  /** Current status of the auth callback flow */
  status: AuthCallbackStatus;

  /** Error message if status is "error" */
  error: string | null;

  /** Whether the auth callback is still in progress */
  isLoading: boolean;

  /** Whether the auth callback completed successfully */
  isSuccess: boolean;

  /** Whether there was an error */
  isError: boolean;

  /** Retry the authentication flow by redirecting to the auth provider */
  retry: () => Promise<void>;
}

/**
 * A hook for handling OAuth/OIDC callback flows.
 *
 * This hook manages the complete authentication callback lifecycle:
 * 1. Processing the OAuth callback from the identity provider
 * 2. Waiting for backend authentication (e.g., Convex)
 * 3. Syncing user data with your backend
 * 4. Handling success and error states
 *
 * @example
 * ```tsx
 * function AuthCallback() {
 *   const navigate = useNavigate();
 *   const { isAuthenticated } = useConvexAuth();
 *   const updateUser = useMutation(api.users.updateCurrentUser);
 *
 *   const { status, error, retry } = useAuthCallback({
 *     isBackendAuthenticated: isAuthenticated,
 *     onSync: () => updateUser(),
 *     onSuccess: () => navigate("/", { replace: true }),
 *     onNoAuthParams: () => navigate("/", { replace: true }),
 *   });
 *
 *   if (status === "error") {
 *     return <ErrorState message={error} onRetry={retry} />;
 *   }
 *
 *   return <LoadingSpinner />;
 * }
 * ```
 *
 * @public
 */
export function useAuthCallback(
  options: UseAuthCallbackOptions = {},
): UseAuthCallbackResult {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    isBackendAuthenticated = true,
    onSync,
    onSuccess,
    onNoAuthParams,
  } = options;

  const {
    isLoading: isAuthLoading,
    isAuthenticated: isOidcAuthenticated,
    error: oidcError,
    signinRedirect,
  } = useAuth();

  const { authority, clientId, redirectUri, diagnostics } =
    useHerculesAuthProvider();

  const [status, setStatus] = useState<AuthCallbackStatus>("processing-oauth");
  const [error, setError] = useState<string | null>(null);

  // Track mount state to prevent state updates after unmount
  const mountedRef = useRef(true);
  // Track if we had auth params on mount (won't change during lifecycle)
  const hadAuthParams = useRef(hasAuthParams());
  // Track if we've already started sync to prevent double execution
  const syncStarted = useRef(false);
  // Track which failure phases have already reported, so a single failure
  // doesn't fire diagnostics on every re-render of the same effect.
  const reportedPhases = useRef<Set<AuthDiagnosticPhase>>(new Set());

  const reportPhase = useCallback(
    (phase: AuthDiagnosticPhase, err: unknown) => {
      if (reportedPhases.current.has(phase)) return;
      reportedPhases.current.add(phase);
      // Synchronous: report immediately with the static authority/client
      // info from the active UserManager. We deliberately don't reach into
      // metadataService here because, if discovery is what failed, that
      // call would either hang on the same failing fetch or trigger
      // another one before we ever get the diagnostic out.
      reportAuthDiagnostic(diagnostics, {
        phase,
        error: err,
        authority,
        clientId,
        redirectUri,
      });
    },
    [diagnostics, authority, clientId, redirectUri],
  );

  // Reset on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    syncStarted.current = false;
    reportedPhases.current = new Set();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Timeout protection with state awareness
  useEffect(() => {
    if (status === "success" || status === "error") return;

    const timeout = setTimeout(() => {
      if (mountedRef.current) {
        reportPhase("callback-timeout", new Error("callback timeout"));
        setStatus("error");
        setError("Authentication timed out. Please try again.");
      }
    }, timeoutMs);

    return () => clearTimeout(timeout);
  }, [status, timeoutMs, reportPhase]);

  // Track OIDC authentication progression
  useEffect(() => {
    // Don't update if we're already past processing or in an error state
    if (status !== "processing-oauth" && status !== "waiting-backend") return;

    // Handle OIDC errors
    if (oidcError) {
      reportPhase("oidc-error", oidcError);
      setStatus("error");
      setError(oidcError.message || "Authentication failed");
      return;
    }

    // No auth params and not authenticated - navigated here directly
    if (!hadAuthParams.current && !isAuthLoading && !isOidcAuthenticated) {
      onNoAuthParams?.();
      return;
    }

    // OIDC is done loading and authenticated - move to waiting for backend
    if (
      !isAuthLoading &&
      isOidcAuthenticated &&
      status === "processing-oauth"
    ) {
      setStatus("waiting-backend");
      return;
    }

    // OIDC finished but not authenticated (and we had auth params)
    // Wait a bit before declaring failure to avoid race conditions
    if (
      hadAuthParams.current &&
      !isAuthLoading &&
      !isOidcAuthenticated &&
      !oidcError &&
      status === "processing-oauth"
    ) {
      // Use a small delay to avoid race condition during OIDC state transitions
      const failureTimeout = setTimeout(() => {
        if (mountedRef.current && !isOidcAuthenticated) {
          reportPhase(
            "callback-not-authenticated",
            new Error("oidc callback completed but not authenticated"),
          );
          setStatus("error");
          setError("Authentication was cancelled or failed. Please try again.");
        }
      }, 500);

      return () => clearTimeout(failureTimeout);
    }

    return;
  }, [
    isAuthLoading,
    isOidcAuthenticated,
    oidcError,
    status,
    onNoAuthParams,
    reportPhase,
  ]);

  // Sync with backend once backend is authenticated
  useEffect(() => {
    if (status !== "waiting-backend" || !isBackendAuthenticated) return;
    if (syncStarted.current) return;

    syncStarted.current = true;

    async function performSync() {
      if (!mountedRef.current) return;

      setStatus("syncing");

      try {
        if (onSync) {
          await onSync();
        }

        if (mountedRef.current) {
          setStatus("success");
        }
      } catch (err) {
        console.error("Auth callback sync failed:", err);

        reportPhase("backend-sync-failed", err);

        if (!mountedRef.current) return;

        if (err instanceof ConvexError) {
          // try to extract the error message from the convex error
          const parseResult = convexErrorSchema.safeParse(err.data);
          if (parseResult.success) {
            setStatus("error");
            setError(parseResult.data.message);
            return;
          }
        }

        // Check if it's an authentication error
        const errorMessage =
          err instanceof Error
            ? err.message
            : "Failed to complete authentication. Please try again.";

        setStatus("error");
        setError(errorMessage);
      }
    }

    performSync();
  }, [status, isBackendAuthenticated, onSync, reportPhase]);

  // Handle successful completion
  useEffect(() => {
    if (status === "success") {
      // Burn the correlation id so the next sign-in flow starts fresh.
      // Failures that happen later in the same tab will still get a new
      // attempt id from the next startAuthAttempt() call.
      clearAuthAttemptId();
      onSuccess?.();
    }
  }, [status, onSuccess]);

  // Retry handler
  const retry = useCallback(async () => {
    // Fresh attempt id so the next failure correlates to this retry.
    startAuthAttempt();
    try {
      await signinRedirect();
    } catch (err) {
      console.error("Failed to restart auth:", err);
      reportAuthDiagnostic(diagnostics, {
        phase: "signin-redirect-failed",
        error: err,
        authority,
        clientId,
        redirectUri,
      });
    }
  }, [signinRedirect, diagnostics, authority, clientId, redirectUri]);

  return {
    status,
    error,
    isLoading: status !== "success" && status !== "error",
    isSuccess: status === "success",
    isError: status === "error",
    retry,
  };
}
