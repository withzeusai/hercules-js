import {
  createEmbeddedAuthClient,
  type EmbeddedAuthClient,
  type EmbeddedAuthClientOptions,
} from "@usehercules/auth-core";

import { getAuthorizationUrl } from "../server/auth";

/**
 * A client for an app that renders its own sign-in UI (embedded sign-in). Its
 * methods call the app's auth API on the app's own origin and resolve to where
 * to go next: the app's `/auth/callback`, which starts the session as usual, or
 * a social provider's consent page.
 *
 * Sign-in works from any page. On the page the authorize endpoint sends
 * signed-out visitors to (`signInPath` from {@link getEmbeddedSignIn}), it
 * completes that request; anywhere else it starts a new one through
 * `getAuthorizationUrl`, so a "Continue with Google" button can live on a
 * landing page.
 *
 * @example
 * ```tsx
 * const auth = createEmbeddedSignInClient();
 * const result = await auth.signInWithSocial({ provider: "google" });
 * if (result.ok) auth.navigate(result);
 * else setError(result.error.message);
 * ```
 */
export function createEmbeddedSignInClient(
  options: Omit<EmbeddedAuthClientOptions, "startAuthorization"> = {},
): EmbeddedAuthClient {
  return createEmbeddedAuthClient({
    ...options,
    startAuthorization: ({ returnTo, prompt }) =>
      getAuthorizationUrl({
        data: {
          ...(returnTo ? { returnPathname: returnTo } : {}),
          ...(prompt ? { prompt } : {}),
        },
      }),
  });
}

export {
  mountTurnstileBridge,
  readAuthError,
  AUTH_ERROR_CODES,
  isAuthError,
  type ActiveSession,
  type AuthError,
  type AuthErrorCode,
  type AuthErrorField,
  type AuthResult,
  type AuthStep,
  type DataResult,
  type EmbeddedAuthClient,
  type LinkedAccount,
  type Passkey,
  type SessionUser,
  type SignInConfig,
  type SignInMethod,
  type SocialProvider,
  type StepResult,
  type TurnstileBridge,
  type TurnstileBridgeOptions,
} from "@usehercules/auth-core";
