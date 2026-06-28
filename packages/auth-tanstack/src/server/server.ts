import * as client from "openid-client";
import { parseCookies, serializeCookie } from "./cookie-utils";
import type { HandleAuthSuccessData, HandleCallbackOptions, HandleSignInOptions } from "./types";

export type { HandleAuthSuccessData, HandleCallbackOptions, HandleSignInOptions } from "./types";

/**
 * OIDC issuer URL used for discovery (`{issuer}/.well-known/openid-configuration`).
 * For Amazon Cognito this is the user-pool issuer
 * (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`), NOT the hosted-UI
 * domain — the hosted domain does not serve the discovery document.
 */
const ISSUER_URL_ENV = "HERCULES_AUTH_ISSUER_URL";
/** OAuth client (app client) identifier. */
const CLIENT_ID_ENV = "HERCULES_AUTH_CLIENT_ID";
/** OAuth client secret. Optional — omit for a public (PKCE-only) client. */
const CLIENT_SECRET_ENV = "HERCULES_AUTH_CLIENT_SECRET";

/** Cookie carrying the PKCE `code_verifier`, written when the sign-in flow began. */
const PKCE_VERIFIER_COOKIE = "hercules_pkce_verifier";
/** Cookie carrying the OAuth `state`, written when the sign-in flow began. */
const STATE_COOKIE = "hercules_oauth_state";
/** Cookie holding the authenticated session token. */
const AUTH_COOKIE = "hercules_session";

/** Where to send the user once the callback completes. */
const DEFAULT_REDIRECT = "/";
/** Callback route the provider returns to, unless overridden. */
const DEFAULT_CALLBACK_PATH = "/api/auth/callback";
/** OAuth scopes requested when none are configured. */
const DEFAULT_SCOPE = "openid profile email";
/** Lifetime (seconds) of the one-time sign-in cookies. */
const SIGN_IN_COOKIE_MAX_AGE = 600;

/** One-time sign-in cookies, cleared once the callback resolves either way. */
const SIGN_IN_COOKIES = [PKCE_VERIFIER_COOKIE, STATE_COOKIE];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[auth-tanstack] Missing required environment variable: ${name}`);
  }
  return value;
}

// Discovery is a network round-trip and the resolved metadata is static for the
// lifetime of the process, so resolve the Configuration once and reuse it.
let configPromise: Promise<client.Configuration> | undefined;
function getConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    const issuerUrl = new URL(requireEnv(ISSUER_URL_ENV));
    const clientId = requireEnv(CLIENT_ID_ENV);
    const clientSecret = process.env[CLIENT_SECRET_ENV];

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

function deleteSignInCookies(headers: Headers): void {
  for (const name of SIGN_IN_COOKIES) {
    headers.append("Set-Cookie", serializeCookie(name, "", { path: "/", maxAge: 0 }));
  }
}

/**
 * Resolve a callback failure into a Response, honoring the caller's error
 * handling preferences (see {@link HandleCallbackOptions}). `onError` wins over
 * `errorRedirectUrl`, which in turn wins over the default JSON error response.
 * All paths clear the one-time sign-in cookies.
 */
async function handleError(
  request: Request,
  status: 400 | 500,
  message: string,
  error: unknown,
  options?: HandleCallbackOptions,
): Promise<Response> {
  // Always log before the response is shaped by caller preferences — otherwise
  // the failure is invisible whenever it's surfaced as a redirect or a generic
  // message. Include the underlying error when there is one.
  if (error !== undefined) {
    console.error(`[auth-tanstack] ${message} (HTTP ${status}):`, error);
  } else {
    console.error(`[auth-tanstack] ${message} (HTTP ${status})`);
  }

  // `onError` is intentionally not wrapped — errors it throws propagate.
  if (options?.onError) {
    return options.onError({ error, request });
  }

  if (options?.errorRedirectUrl) {
    try {
      const location = new URL(options.errorRedirectUrl, new URL(request.url).origin).toString();
      const headers = new Headers({ Location: location });
      deleteSignInCookies(headers);
      return new Response(null, { status: 302, headers });
    } catch {
      // Malformed config value — warn and fall back to the JSON error response.
      console.warn(`[auth-tanstack] Ignoring malformed errorRedirectUrl: ${options.errorRedirectUrl}`);
    }
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  deleteSignInCookies(headers);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/**
 * Build a TanStack route handler that initiates the OIDC login.
 *
 * Navigating to (redirecting to) the route this is mounted on starts the
 * Authorization Code + PKCE flow: it generates a fresh `code_verifier` and
 * `state`, stashes them in short-lived cookies for {@link handleCallbackRoute}
 * to consume, and redirects the user-agent to the provider's authorization
 * endpoint.
 *
 * @public
 */
export function handleSignInRoute(options?: HandleSignInOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    return handleSignInInternal(request, options);
  };
}

async function handleSignInInternal(
  request: Request,
  options?: HandleSignInOptions,
): Promise<Response> {
  const url = new URL(request.url);

  // These must be unique per authorization request and tied to the user-agent.
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const redirectUri = new URL(options?.redirectUri ?? DEFAULT_CALLBACK_PATH, url.origin).toString();

  let authorizationUrl: URL;
  try {
    const config = await getConfig();
    authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: options?.scope ?? DEFAULT_SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  } catch (error) {
    // Almost always OIDC discovery failing in getConfig() (bad issuer URL,
    // missing env var, or the provider being unreachable). Log it so the cause
    // is visible rather than swallowed behind the generic client message.
    console.error("[auth-tanstack] Failed to start sign-in:", error);
    return new Response(JSON.stringify({ error: "Failed to start sign-in" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers({ Location: authorizationUrl.toString() });

  // Stash the PKCE verifier and state for the callback. SameSite=Lax so they
  // survive the top-level redirect back from the provider.
  const cookieOptions = {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SIGN_IN_COOKIE_MAX_AGE,
  };
  headers.append("Set-Cookie", serializeCookie(PKCE_VERIFIER_COOKIE, codeVerifier, cookieOptions));
  headers.append("Set-Cookie", serializeCookie(STATE_COOKIE, state, cookieOptions));

  return new Response(null, { status: 302, headers });
}

/**
 * Build a TanStack route handler for the OAuth/OIDC callback.
 *
 * The handler completes the authorization-code grant using the PKCE
 * `code_verifier` and `state` stashed in cookies during sign-in, invokes
 * {@link HandleCallbackOptions.onSuccess} with the token response, stores the
 * resulting session token in an HttpOnly cookie, clears the one-time sign-in
 * cookies, and redirects the user to {@link HandleCallbackOptions.returnPathname}.
 *
 * @public
 */
export function handleCallbackRoute(options?: HandleCallbackOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    return handleCallbackInternal(request, options);
  };
}

async function handleCallbackInternal(
  request: Request,
  options?: HandleCallbackOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return handleError(request, 400, "Missing code parameter", undefined, options);
  }

  const cookies = parseCookies(request.headers.get("cookie") ?? "");

  const pkceCodeVerifier = cookies[PKCE_VERIFIER_COOKIE];
  if (!pkceCodeVerifier) {
    return handleError(request, 400, "Missing PKCE verifier", undefined, options);
  }

  // Sign-in always sends `state` and stores the matching cookie, so the callback
  // must always prove it belongs to that request. Require the stored value and
  // pass it as `expectedState` unconditionally — `authorizationCodeGrant` then
  // rejects a response whose `state` is missing or mismatched (CSRF defense).
  const expectedState = cookies[STATE_COOKIE];
  if (!expectedState) {
    return handleError(request, 400, "Missing state cookie", undefined, options);
  }
  const checks: client.AuthorizationCodeGrantChecks = { pkceCodeVerifier, expectedState };

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    const config = await getConfig();
    tokens = await client.authorizationCodeGrant(config, url, checks);
  } catch (error) {
    return handleError(request, 500, "Token exchange failed", error, options);
  }

  // `access_token` is always present in a successful token response, so the
  // session token below is guaranteed to be a string.
  const data: HandleAuthSuccessData = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    claims: tokens.claims(),
    state: url.searchParams.get("state") ?? undefined,
  };

  await options?.onSuccess?.(data);

  const secure = url.protocol === "https:";
  const headers = new Headers({ Location: options?.returnPathname ?? DEFAULT_REDIRECT });

  // Persist the session token (prefer the ID token) for subsequent requests.
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_COOKIE, data.idToken ?? data.accessToken, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: data.expiresIn,
    }),
  );

  // Clear the one-time sign-in cookies now that the flow is complete.
  deleteSignInCookies(headers);

  return new Response(null, { status: 302, headers });
}
