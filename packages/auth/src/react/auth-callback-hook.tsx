"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useAuth, hasAuthParams } from "react-oidc-context";
import { ConvexError } from "convex/values";
import * as z from "zod";

const DEFAULT_TIMEOUT_MS = 20000;

const convexErrorSchema = z.object({
  message: z.string(),
});

/**
 * Authentication callback status states
 * @public
 */
export type AuthCallbackStatus =
  | "processing-oauth"
  | "waiting-backend"
  | "syncing"
  | "success"
  | "error";

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

  const [status, setStatus] = useState<AuthCallbackStatus>("processing-oauth");
  const [error, setError] = useState<string | null>(null);

  // Stable snapshot of whether auth params were present on first mount.
  const [hadAuthParams] = useState(() => hasAuthParams());

  // Latest callbacks, kept in a ref so effects don't churn when parents
  // pass inline functions.
  const callbacksRef = useRef({ onSync, onSuccess, onNoAuthParams });
  callbacksRef.current = { onSync, onSuccess, onNoAuthParams };

  // Guard one-shot side effects.
  const syncStartedRef = useRef(false);
  const successFiredRef = useRef(false);
  const noAuthParamsFiredRef = useRef(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Single wall-clock deadline from mount. Using the functional setState
  // form lets us no-op when we've already reached a terminal state, so the
  // timer doesn't need to reset on each status transition.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!mountedRef.current) return;
      setStatus((s) => {
        if (s === "success" || s === "error") return s;
        setError("Authentication timed out. Please try again.");
        return "error";
      });
    }, timeoutMs);

    return () => clearTimeout(timeout);
  }, [timeoutMs]);

  // OIDC progression: processing-oauth -> waiting-backend, or error.
  useEffect(() => {
    if (status !== "processing-oauth") return;

    if (oidcError) {
      // If OIDC is also reporting an authenticated user, the error came
      // from a concurrent silent/retry op (common in StrictMode when the
      // init effect runs twice and the second signinCallback sees a
      // consumed code). Treat the user as authenticated.
      if (isOidcAuthenticated) {
        setStatus("waiting-backend");
        return;
      }
      setStatus("error");
      setError(oidcError.message || "Authentication failed");
      return;
    }

    if (isOidcAuthenticated) {
      setStatus("waiting-backend");
      return;
    }

    // No auth params on mount and OIDC has settled unauthenticated —
    // user landed on the callback page directly.
    if (!hadAuthParams && !isAuthLoading && !noAuthParamsFiredRef.current) {
      noAuthParamsFiredRef.current = true;
      callbacksRef.current.onNoAuthParams?.();
    }

    // If we had auth params but OIDC settled unauthenticated with no error,
    // we intentionally do NOT declare failure here. react-oidc-context can
    // reach this shape from benign paths (silent nav close, INITIALISED with
    // null user due to storage issues, StrictMode double-init, etc.). The
    // wall-clock timeout above is the authoritative "stuck" signal.
  }, [isAuthLoading, isOidcAuthenticated, oidcError, status, hadAuthParams]);

  useEffect(() => {
    if (status !== "waiting-backend" || !isBackendAuthenticated) return;
    if (syncStartedRef.current) return;

    syncStartedRef.current = true;

    async function performSync() {
      if (!mountedRef.current) return;

      setStatus("syncing");

      try {
        const { onSync } = callbacksRef.current;
        if (onSync) await onSync();

        if (mountedRef.current) setStatus("success");
      } catch (err) {
        console.error("Auth callback sync failed:", err);

        if (!mountedRef.current) return;

        if (err instanceof ConvexError) {
          const parseResult = convexErrorSchema.safeParse(err.data);
          if (parseResult.success) {
            setStatus("error");
            setError(parseResult.data.message);
            return;
          }
        }

        setStatus("error");
        setError(
          err instanceof Error
            ? err.message
            : "Failed to complete authentication. Please try again.",
        );
      }
    }

    performSync();
  }, [status, isBackendAuthenticated]);

  useEffect(() => {
    if (status !== "success" || successFiredRef.current) return;
    successFiredRef.current = true;
    callbacksRef.current.onSuccess?.();
  }, [status]);

  const retry = useCallback(async () => {
    try {
      await signinRedirect();
    } catch (err) {
      console.error("Failed to restart auth:", err);
    }
  }, [signinRedirect]);

  return {
    status,
    error,
    isLoading: status !== "success" && status !== "error",
    isSuccess: status === "success",
    isError: status === "error",
    retry,
  };
}
