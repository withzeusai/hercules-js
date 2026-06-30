import * as client from "openid-client";
import { fromBase64Url, toBase64Url } from "./encoding";

// Each value accepts several variable names, tried in order: the canonical
// `HERCULES_AUTH_*` name, a standard OIDC alias where one applies, then the
// unprefixed `AUTH_*` name as a last resort.

/**
 * OIDC issuer URL used for discovery (`{issuer}/.well-known/openid-configuration`).
 * For Amazon Cognito this is the user-pool issuer
 * (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`), NOT the hosted-UI
 * domain — the hosted domain does not serve the discovery document.
 */
export const ISSUER_URL_ENV_VARS = [
  "HERCULES_AUTH_ISSUER_URL",
  "HERCULES_OIDC_AUTHORITY",
  "AUTH_ISSUER_URL",
] as const;
/** OAuth client (app client) identifier. */
export const CLIENT_ID_ENV_VARS = [
  "HERCULES_AUTH_CLIENT_ID",
  "HERCULES_OIDC_CLIENT_ID",
  "AUTH_CLIENT_ID",
] as const;
/** OAuth client secret. Optional — omit for a public (PKCE-only) client. */
export const CLIENT_SECRET_ENV_VARS = [
  "HERCULES_AUTH_CLIENT_SECRET",
  "AUTH_CLIENT_SECRET",
] as const;

/** Where to send the user once the callback completes. */
export const DEFAULT_REDIRECT = "/";
/** Callback route the provider returns to, unless overridden. */
export const DEFAULT_CALLBACK_PATH = "/auth/callback";
/** OAuth scopes requested when none are configured. */
export const DEFAULT_SCOPE = "openid profile email";
/** Lifetime (seconds) of a pending sign-in's PKCE cookie. */
export const SIGN_IN_COOKIE_MAX_AGE = 600;
/**
 * Cap on simultaneously pending sign-in flows. Beyond this we expire surplus
 * verifier cookies on the next sign-in so the request `Cookie` header cannot
 * grow without bound from abandoned attempts.
 */
export const MAX_PENDING_SIGN_INS = 10;
/**
 * Prefix for per-flow PKCE cookies. Each pending sign-in stores its
 * `code_verifier` under `${PKCE_COOKIE_PREFIX}${state}`, so concurrent flows
 * (a double-click, a retry, a second tab) keep independent cookies instead of
 * overwriting one shared name and invalidating each other.
 */
export const PKCE_COOKIE_PREFIX = "hercules_pkce_";

/** Cookie name holding the PKCE verifier for the flow identified by `state`. */
export function pkceCookieName(state: string): string {
  return PKCE_COOKIE_PREFIX + state;
}

/** First non-empty value among `names`, or undefined when none are set. */
export function readEnv(names: readonly [string, ...string[]]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Like {@link readEnv} but throws when none of the accepted names are set,
 * listing them all so the caller knows every variable that would satisfy it.
 */
export function requireEnv(names: readonly [string, ...string[]]): string {
  const value = readEnv(names);
  if (value === undefined) {
    throw new Error(`[auth-tanstack] Missing required environment variable: ${names.join(" or ")}`);
  }
  return value;
}

// Discovery is a network round-trip and the resolved metadata is static for the
// lifetime of the process, so resolve the Configuration once and reuse it.
let configPromise: Promise<client.Configuration> | undefined;
export function getConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    const issuerUrl = new URL(requireEnv(ISSUER_URL_ENV_VARS));
    const clientId = requireEnv(CLIENT_ID_ENV_VARS);
    const clientSecret = readEnv(CLIENT_SECRET_ENV_VARS);

    // A public client authenticates with PKCE alone (no secret); a confidential
    // client authenticates the token request with its secret.
    const discovered = clientSecret
      ? client.discovery(issuerUrl, clientId, clientSecret)
      : client.discovery(issuerUrl, clientId, undefined, client.None());

    configPromise = discovered.catch((error) => {
      // Don't cache a failed discovery — let the next request retry instead of
      // permanently poisoning every sign-in and callback.
      configPromise = undefined;
      throw error;
    });
  }
  return configPromise;
}

/**
 * Contents of a per-flow PKCE cookie: the `code_verifier` plus the optional
 * post-sign-in destination so the callback can honor it.
 */
export interface PkceState {
  verifier: string;
  returnPathname?: string;
}

const pkceTextEncoder = new TextEncoder();
const pkceTextDecoder = new TextDecoder();

/** Serialize a {@link PkceState} into a compact, cookie-safe string. */
export function encodePkceState(state: PkceState): string {
  const payload: { v: string; r?: string } = { v: state.verifier };
  if (state.returnPathname) payload.r = state.returnPathname;
  return toBase64Url(pkceTextEncoder.encode(JSON.stringify(payload)));
}

/**
 * Parse a PKCE cookie value. Falls back to treating the whole value as a bare
 * verifier so cookies written by older sign-ins (raw verifier strings) still
 * resolve.
 */
export function decodePkceState(raw: string): PkceState {
  try {
    const decoded = JSON.parse(pkceTextDecoder.decode(fromBase64Url(raw))) as {
      v?: unknown;
      r?: unknown;
    };
    if (decoded && typeof decoded.v === "string") {
      return {
        verifier: decoded.v,
        returnPathname: typeof decoded.r === "string" ? decoded.r : undefined,
      };
    }
  } catch {
    // Not an envelope — treat the raw value as a bare verifier (back-compat).
  }
  return { verifier: raw };
}
