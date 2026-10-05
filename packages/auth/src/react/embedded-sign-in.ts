import {
  createEmbeddedAuthClient,
  type EmbeddedAuthClient,
  type EmbeddedAuthClientOptions,
  readEmbeddedSignInMetadata,
} from "@usehercules/auth-core";
import { useMemo } from "react";
import { HerculesUserManager } from "../internal/user-manager";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";

/** Where an app with embedded sign-in renders it, from the tenant's discovery document. */
export interface EmbeddedSignInSettings {
  /** The OIDC issuer; the captcha bridge renders on its origin. */
  issuer: string;
  authBasePath: string;
  signInPath: string;
  signUpPath: string;
}

/**
 * The app's embedded sign-in settings, or null when users sign in on the
 * hosted portal. Read from discovery, so it follows the dashboard setting.
 */
export async function getEmbeddedSignIn(
  userManager: HerculesUserManager,
): Promise<EmbeddedSignInSettings | null> {
  const metadata = await userManager.metadataService.getMetadata();
  const embedded = readEmbeddedSignInMetadata(metadata as Record<string, unknown>);
  if (!embedded || typeof metadata.issuer !== "string") return null;
  return { issuer: metadata.issuer, ...embedded };
}

/**
 * A client for an app that renders its own sign-in UI. Its methods call the
 * app's auth API on the app's own origin and resolve to where to go next: the
 * app's `/auth/callback` (handled by `useAuthCallback` as usual) or a social
 * provider's consent page. Works on the sign-in page the authorize endpoint
 * sends visitors to and from any other page, such as a landing-page
 * "Continue with Google" button.
 *
 * @example
 * ```tsx
 * const auth = useEmbeddedSignIn();
 * const result = await auth.signInWithSocial({ provider: "google" });
 * if (result.ok) auth.navigate(result);
 * ```
 */
export function useEmbeddedSignIn(
  options: Omit<EmbeddedAuthClientOptions, "startAuthorization"> = {},
): EmbeddedAuthClient {
  const { userManager } = useHerculesAuthProvider();
  const { basePath, fetch, location, captcha, captchaContainer, isFramed } = options;
  return useMemo(
    () =>
      createEmbeddedAuthClient({
        ...(basePath ? { basePath } : {}),
        ...(fetch ? { fetch } : {}),
        ...(location ? { location } : {}),
        ...(captcha ? { captcha } : {}),
        ...(captchaContainer ? { captchaContainer } : {}),
        ...(isFramed ? { isFramed } : {}),
        startAuthorization: ({ returnTo, prompt }) => {
          if (!(userManager instanceof HerculesUserManager)) {
            throw new Error("useEmbeddedSignIn needs the HerculesAuthProvider user manager");
          }
          return userManager.createAuthorizationUrl({
            ...(returnTo ? { returnTo } : {}),
            ...(prompt ? { prompt } : {}),
          });
        },
      }),
    [userManager, basePath, fetch, location, captcha, captchaContainer, isFramed],
  );
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
