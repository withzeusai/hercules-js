import { mountTurnstileBridge, type TurnstileBridge } from "./captcha";
import { type AuthError, authError } from "./errors";
import { fromBase64UrlString, toBase64UrlString } from "./encoding";
import {
  creationOptionsFromJSON,
  credentialToJSON,
  isWebAuthnAvailable,
  requestOptionsFromJSON,
} from "./webauthn";

/**
 * Embedded sign-in client, shaped after WorkOS's AuthKit Authentication API
 * (`authenticateWithPassword`, `authenticateWithMagicAuth`,
 * `getAuthorizationUrl`, `authenticateWithEmailVerification` with a
 * `pendingAuthenticationToken`, ...), but running in the browser.
 *
 * When a Hercules app renders its own sign-in UI, the platform serves the app's
 * auth API on the app's own origin under {@link DEFAULT_AUTH_BASE_PATH}. Every
 * `authenticateWith*` call finishes the way the hosted portal does: the request
 * carries the signed authorization query (`oauth_query`), the server completes
 * the OIDC authorize step in the same response, and the result is a redirect to
 * the app's `/auth/callback?code=...`. Navigating there lets the app's SDK
 * exchange the code and start its session, so nothing downstream changes.
 *
 * The signed query comes from the current URL, when the authorize endpoint sent
 * the visitor to this page, or from a fresh authorization request the framework
 * adapter starts (`startAuthorization`), so sign-in also works from any page.
 */

/** Where the platform serves the app's auth API on its own origin. */
export const DEFAULT_AUTH_BASE_PATH = "/_hercules/auth";

export type SocialProvider = "google" | "apple" | "microsoft" | "facebook" | "linkedin";

/** WorkOS's provider names, accepted as aliases. */
export type WorkOSProviderName =
  | "GoogleOAuth"
  | "AppleOAuth"
  | "MicrosoftOAuth"
  | "FacebookOAuth"
  | "LinkedInOAuth";

const PROVIDER_ALIASES: Record<WorkOSProviderName, SocialProvider> = {
  GoogleOAuth: "google",
  AppleOAuth: "apple",
  MicrosoftOAuth: "microsoft",
  FacebookOAuth: "facebook",
  LinkedInOAuth: "linkedin",
};

function socialProvider(provider: SocialProvider | WorkOSProviderName): SocialProvider {
  return (
    (PROVIDER_ALIASES as Record<string, SocialProvider>)[provider] ?? (provider as SocialProvider)
  );
}

export type SignInMethod =
  | SocialProvider
  | "email_otp"
  | "email_password"
  | "phone_otp"
  | "username_password";

/** The tenant's public sign-in settings. */
export interface SignInConfig {
  /** The OIDC issuer; the captcha renders on its origin. */
  issuer: string;
  appName: string;
  logoUrl: string | null;
  language: string;
  theme: string;
  /** Legal links to show under the sign-in buttons, or null when hidden. */
  terms: { tosUrl: string | null; privacyUrl: string | null } | null;
  callout: { text: string; color: string } | null;
  /** Which sign-in methods the app owner turned on. */
  enabledProviders: Record<SignInMethod, boolean>;
  /** Username self sign-up, or null when username accounts are admin-created. */
  usernameSignUp: { mode: "user_chosen" | "auto_generated"; prefix: string } | null;
  /** Whether a password sign-up must verify its address before signing in. */
  requireEmailVerification: boolean;
  /** `code`: typed into the app (`authenticateWithEmailVerification`); `link`: emailed. */
  emailVerificationMethod: "code" | "link";
  /** Whether a visitor the allowlist turns away may request access. */
  accessRequestsEnabled: boolean;
  embedded: { signInPath: string; signUpPath: string } | null;
}

export interface StartAuthorizationOptions {
  /** App path to land on once signed in. Defaults to the current page. */
  returnTo?: string;
  /** `"create"` asks for the sign-up flavor of the sign-in page. */
  prompt?: "create";
}

export interface EmbeddedAuthClientOptions {
  /** Auth API base path on this origin. Defaults to {@link DEFAULT_AUTH_BASE_PATH}. */
  basePath?: string;
  /**
   * Begin an authorization request and return its authorize URL on this
   * origin. Supplied by the framework adapter; needed only to start a sign-in
   * from a page the authorize endpoint did not send the visitor to.
   */
  startAuthorization?: (options: StartAuthorizationOptions) => Promise<string>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `window.location`. */
  location?: Pick<Location, "origin" | "search" | "pathname" | "href" | "assign">;
  /**
   * Captcha handling. `"auto"` (the default) renders the Turnstile widget when
   * a request needs a token, into `#hercules-captcha` when the page has one,
   * otherwise a small corner panel, and resets it after each request.
   * `"manual"` leaves it to the caller, who passes `captchaToken`.
   */
  captcha?: "auto" | "manual";
  /** Where `"auto"` captcha renders. Defaults to `#hercules-captcha`, then a corner panel. */
  captchaContainer?: () => HTMLElement | null;
  /**
   * Whether the app runs inside a frame (the dashboard preview). Social
   * sign-in then runs in a popup, since providers refuse to be framed.
   * Defaults to checking `window.top`.
   */
  isFramed?: () => boolean;
}

/**
 * An `authenticateWith*` call either produced somewhere to go next (the app
 * callback with a code, or a social provider's consent page), or failed.
 * `email_verification_required` and future continuations arrive as errors that
 * carry what the next call needs, as in WorkOS.
 */
export type AuthResult =
  | {
      ok: true;
      /** Navigate here (`auth.navigate(result)`). */
      redirectTo: string;
      /** The username an auto-generated username sign-up was assigned. */
      username?: string;
    }
  | { ok: false; error: AuthError };

/** The outcome of a call that signs nobody in, such as sending a code. */
export type StepResult = { ok: true } | { ok: false; error: AuthError };

/** The outcome of a read. */
export type DataResult<T> = { ok: true; data: T } | { ok: false; error: AuthError };

export interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
  username?: string | null;
  phoneNumber?: string | null;
  createdAt: string;
}

/** A sign-in method linked to the user (WorkOS: identity). */
export interface Identity {
  /** Pass to `unlinkIdentity`. */
  id: string;
  /** `password` for a password, otherwise the social provider (`google`, ...). */
  provider: SocialProvider | "password" | (string & {});
  /** The user's id at the provider. */
  providerUserId: string;
  createdAt: string;
}

/** A signed-in device. */
export interface Session {
  /** Pass to `revokeSession`. */
  id: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface Passkey {
  /** Pass to `deletePasskey`. */
  id: string;
  name: string | null;
  createdAt: string;
  deviceType?: string;
}

interface CaptchaOption {
  /** Turnstile token when `captcha: "manual"`. */
  captchaToken?: string;
}

/** The signed parameters `authorize` hands the sign-in page. */
type SignedQuery = { query: string } | { signedIn: string };

/** Signed-query bookkeeping the authorize endpoint adds; not authorize parameters. */
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_POLL_MS = 500;

/** Endpoints the tenant protects with Turnstile. */
const CAPTCHA_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/username",
  "/sign-up/username",
  "/email-otp/send-verification-otp",
  "/request-password-reset",
  "/phone-number/send-otp",
  "/phone-number/verify",
]);

const CAPTCHA_ELEMENT_ID = "hercules-captcha";

const NO_AUTHORIZATION: AuthError = authError(
  "invalid_request",
  "This page has no sign-in request to complete. Open it through the app's sign-in link, or pass startAuthorization.",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string, status = 0): { ok: false; error: AuthError } {
  return { ok: false, error: authError(code, message, status) };
}

/** A small fixed panel for the widget when the page has no `#hercules-captcha`. */
function cornerCaptchaContainer(): HTMLElement {
  const panel = document.createElement("div");
  panel.dataset.herculesCaptcha = "";
  Object.assign(panel.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    width: "300px",
    maxWidth: "calc(100vw - 32px)",
    zIndex: "2147483647",
  });
  document.body.appendChild(panel);
  return panel;
}

/** What a `pendingAuthenticationToken` carries: the address being verified. */
interface PendingAuthentication {
  email: string;
}

function encodePending(pending: PendingAuthentication): string {
  return toBase64UrlString(JSON.stringify(pending));
}

function decodePending(token: string): PendingAuthentication | null {
  try {
    const value: unknown = JSON.parse(fromBase64UrlString(token));
    return isRecord(value) && typeof value.email === "string" ? { email: value.email } : null;
  } catch {
    return null;
  }
}

/**
 * The signed authorize query in `search`, or null when the page was not opened
 * by the authorize endpoint. Only the presence of `sig` is checked here.
 */
export function readSignedQuery(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(query).has("sig") ? query : null;
}

/** The error the server put on the page URL (`?error=...`), so the page can show it. */
export function readAuthError(search: string): AuthError | null {
  const params = new URLSearchParams(search);
  const code = params.get("error");
  if (!code) return null;
  const rejectedEmail = params.get("rejected_email");
  return authError(code, params.get("error_description") ?? code, 0, {
    ...(rejectedEmail ? { rejectedEmail } : {}),
  });
}

function defaultIsFramed(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}

export function createEmbeddedAuthClient(options: EmbeddedAuthClientOptions = {}) {
  const basePath = options.basePath ?? DEFAULT_AUTH_BASE_PATH;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const location = () => options.location ?? window.location;
  const isFramed = options.isFramed ?? defaultIsFramed;
  const captchaMode = options.captcha ?? "auto";

  // ------------------------------------------------------------- transport

  let configPromise: Promise<DataResult<SignInConfig>> | null = null;
  function loadConfig(): Promise<DataResult<SignInConfig>> {
    configPromise ??= read<SignInConfig>("/config").then((result) => {
      if (!result.ok) configPromise = null;
      return result;
    });
    return configPromise;
  }

  let bridge: TurnstileBridge | null = null;
  let bridgePromise: Promise<TurnstileBridge> | null = null;
  function captchaBridge(): Promise<TurnstileBridge> {
    // React may have unmounted the element the widget lived in; mount again.
    if (bridge && !bridge.iframe.isConnected) {
      bridge.destroy();
      bridge = null;
      bridgePromise = null;
    }
    bridgePromise ??= loadConfig()
      .then((config) => {
        if (!config.ok) throw new Error(config.error.message);
        const container =
          options.captchaContainer?.() ??
          document.getElementById(CAPTCHA_ELEMENT_ID) ??
          cornerCaptchaContainer();
        bridge = mountTurnstileBridge({
          issuer: config.data.issuer,
          container,
          language: config.data.language,
        });
        return bridge;
      })
      .catch((error: unknown) => {
        bridgePromise = null;
        throw error;
      });
    return bridgePromise;
  }

  /** A Turnstile token for `path`, when it needs one and the caller gave none. */
  async function autoCaptchaToken(path: string): Promise<string | AuthError | undefined> {
    if (captchaMode !== "auto" || !CAPTCHA_PATHS.has(path) || typeof document === "undefined") {
      return undefined;
    }
    try {
      return await (await captchaBridge()).getToken();
    } catch (error) {
      return authError(
        "captcha_failed",
        error instanceof Error ? error.message : "Security verification is unavailable.",
      );
    }
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    captchaToken?: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: AuthError }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    let usedAutoCaptcha = false;
    if (!captchaToken) {
      const auto = await autoCaptchaToken(path);
      if (typeof auto === "object") return { ok: false, error: auto };
      if (auto) {
        captchaToken = auto;
        usedAutoCaptcha = true;
      }
    }
    if (captchaToken) headers["x-captcha-response"] = captchaToken;
    let response: Response;
    try {
      response = await doFetch(`${basePath}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "same-origin",
      });
    } catch (error) {
      return failure("network_error", error instanceof Error ? error.message : "Network error");
    } finally {
      // Turnstile tokens are single use.
      if (usedAutoCaptcha) bridge?.reset();
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = isRecord(parsed) ? parsed : {};
      const code =
        typeof record.code === "string"
          ? record.code
          : typeof record.error === "string"
            ? record.error
            : `HTTP_${response.status}`;
      const message =
        typeof record.message === "string"
          ? record.message
          : typeof record.error_description === "string"
            ? record.error_description
            : response.statusText || code;
      return { ok: false, error: authError(code, message, response.status) };
    }
    return { ok: true, body: parsed };
  }

  async function step(
    path: string,
    body: Record<string, unknown>,
    captchaToken?: string,
  ): Promise<StepResult> {
    const result = await request("POST", path, body, captchaToken);
    return result.ok ? { ok: true } : result;
  }

  async function read<T>(path: string): Promise<DataResult<T>> {
    const result = await request("GET", path);
    return result.ok ? { ok: true, data: result.body as T } : result;
  }

  /** The `url` of a `{ redirect: true, url }` body, resolved on this origin. */
  function redirectFrom(body: unknown): string | null {
    if (!isRecord(body) || typeof body.url !== "string") return null;
    return new URL(body.url, location().origin).toString();
  }

  // ---------------------------------------------------------- authorization

  /**
   * The signed query for this sign-in: from the page URL, or from a fresh
   * authorization request. When the browser already holds a session, authorize
   * answers with the app callback instead, and the sign-in is already done.
   */
  async function signedQuery(start: StartAuthorizationOptions): Promise<SignedQuery | null> {
    const fromPage = readSignedQuery(location().search);
    if (fromPage) return { query: fromPage };
    if (!options.startAuthorization) return null;

    const authorizeUrl = await options.startAuthorization({
      returnTo: start.returnTo ?? `${location().pathname}${location().search}`,
      ...(start.prompt ? { prompt: start.prompt } : {}),
    });
    // A fetch (not a navigation) makes authorize answer `{ redirect, url }`.
    const response = await doFetch(authorizeUrl, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    const target = redirectFrom(await response.json().catch(() => null));
    if (!target) return null;
    const query = readSignedQuery(new URL(target).search);
    return query ? { query } : { signedIn: target };
  }

  /**
   * After a session was created, authorize can send the browser back to the
   * sign-in page instead of the app (with `prompt=create` it lands on sign-up).
   * `/oauth2/continue` acknowledges that and returns the code redirect.
   */
  async function finishAuthorization(target: string, query: string): Promise<AuthResult> {
    if (!readSignedQuery(new URL(target).search)) return { ok: true, redirectTo: target };
    const prompt = new URLSearchParams(query).get("prompt") ?? "";
    const result = await request("POST", "/oauth2/continue", {
      ...(prompt.includes("create") ? { created: true } : { selected: true }),
      oauth_query: query,
    });
    if (!result.ok) return result;
    const redirectTo = redirectFrom(result.body);
    return redirectTo
      ? { ok: true, redirectTo }
      : failure("unknown_error", "Sign-in succeeded but the server returned no redirect.", 200);
  }

  /**
   * Run a session-creating request with the signed query attached. `email`
   * names the address for an `email_verification_required` continuation.
   */
  async function authenticate(
    path: string,
    body: Record<string, unknown>,
    start: StartAuthorizationOptions & CaptchaOption & { email?: string },
  ): Promise<AuthResult> {
    const signed = await signedQuery(start);
    if (!signed) return { ok: false, error: NO_AUTHORIZATION };
    if ("signedIn" in signed) return { ok: true, redirectTo: signed.signedIn };

    const result = await request(
      "POST",
      path,
      { ...body, oauth_query: signed.query },
      start.captchaToken,
    );
    if (!result.ok) {
      if (result.error.code === "email_verification_required" && start.email) {
        return { ok: false, error: verificationRequired(start.email, result.error) };
      }
      return result;
    }
    const target = redirectFrom(result.body);
    const username =
      isRecord(result.body) && typeof result.body.username === "string"
        ? result.body.username
        : undefined;
    if (!target) {
      // A password sign-up that must verify its address gets no session yet.
      if (isRecord(result.body) && result.body.token == null && isRecord(result.body.user)) {
        const email =
          start.email ?? (typeof result.body.user.email === "string" ? result.body.user.email : "");
        return { ok: false, error: verificationRequired(email) };
      }
      return failure(
        "unknown_error",
        "Sign-in succeeded but the server returned no redirect.",
        200,
      );
    }
    const finished = await finishAuthorization(target, signed.query);
    return finished.ok && username ? { ...finished, username } : finished;
  }

  function verificationRequired(email: string, cause?: AuthError): AuthError {
    return authError(
      "email_verification_required",
      cause?.message ?? "Check your email to verify your address.",
      cause?.status ?? 200,
      { email, pendingAuthenticationToken: encodePending({ email }) },
    );
  }

  /**
   * Social sign-in inside a frame: providers refuse to be framed, so the
   * provider leg runs in a popup on this origin, and the frame claims the
   * result once it closes. The popup must open synchronously in the click.
   */
  async function socialInPopup(
    provider: SocialProvider,
    start: StartAuthorizationOptions,
  ): Promise<AuthResult> {
    const popup = window.open("", "_blank", "popup,width=500,height=650");
    if (!popup) {
      return failure("popup_blocked", "Allow pop-ups for this site to sign in with this provider.");
    }
    const close = () => {
      if (!popup.closed) popup.close();
    };

    const signed = await signedQuery(start);
    if (!signed) {
      close();
      return { ok: false, error: NO_AUTHORIZATION };
    }
    if ("signedIn" in signed) {
      close();
      return { ok: true, redirectTo: signed.signedIn };
    }
    const authorize = new URL(`${basePath}/oauth2/authorize`, location().origin);
    authorize.search = signed.query;
    for (const name of SIGNATURE_PARAMS) authorize.searchParams.delete(name);

    const requestId = crypto.randomUUID();
    const started = await request("POST", "/popup-session/start", {
      requestId,
      provider,
      authorizeUrl: authorize.toString(),
      handoff: "popup",
    });
    if (!started.ok) {
      close();
      return started;
    }
    const launch = new URL(`${basePath}/popup-session/launch`, location().origin);
    launch.searchParams.set("provider", provider);
    launch.searchParams.set("requestId", requestId);
    popup.location.href = launch.toString();

    const deadline = Date.now() + POPUP_TIMEOUT_MS;
    while (!popup.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POPUP_POLL_MS));
    }
    close();

    const claimed = await request("POST", "/popup-session/claim", { requestId });
    if (!claimed.ok) {
      return claimed.error.status === 404
        ? failure("popup_closed", "Sign-in was not completed.", 404)
        : claimed;
    }
    const body = claimed.body;
    return isRecord(body) && typeof body.redirectUrl === "string"
      ? { ok: true, redirectTo: body.redirectUrl }
      : failure("unknown_error", "Sign-in succeeded but the server returned no redirect.", 200);
  }

  // Session tokens never leave this module; `revokeSession` takes the id.
  const sessionTokens = new Map<string, string>();

  async function listSessionRows(): Promise<DataResult<(Session & { token: string })[]>> {
    const result = await read<(Session & { token: string })[]>("/list-sessions");
    if (result.ok) for (const row of result.data) sessionTokens.set(row.id, row.token);
    return result;
  }

  return {
    // ----------------------------------------------------------------- page

    /** The app's public sign-in settings: enabled methods, branding, sign-up options. Cached. */
    getConfig(): Promise<DataResult<SignInConfig>> {
      return loadConfig();
    },

    /**
     * Render the captcha now rather than on the first request that needs it,
     * so its token is ready by the time the user submits.
     */
    async prepareCaptcha(): Promise<StepResult> {
      if (captchaMode !== "auto") return { ok: true };
      try {
        await captchaBridge();
        return { ok: true };
      } catch (error) {
        return failure(
          "captcha_failed",
          error instanceof Error ? error.message : "Security verification is unavailable.",
        );
      }
    },

    /** Whether the authorize endpoint opened this page with a sign-in to complete. */
    hasPendingSignIn(): boolean {
      return readSignedQuery(location().search) !== null;
    },

    /** Whether the visitor was sent here to create an account. */
    isSignUpRequest(): boolean {
      const params = new URLSearchParams(location().search);
      return params.get("prompt") === "create" || params.get("screen_hint") === "sign-up";
    },

    /** An error the server put on this page's URL, if any. */
    pageError(): AuthError | null {
      return readAuthError(location().search);
    },

    /** Navigate to a successful result's `redirectTo`. */
    navigate(result: Extract<AuthResult, { ok: true }>): void {
      location().assign(result.redirectTo);
    },

    // ------------------------------------------------------- authentication

    /**
     * Sign in with a social provider (WorkOS: `getAuthorizationUrl` plus the
     * redirect). Top-level, `redirectTo` is the provider's consent page; inside
     * a frame it runs in a popup and resolves to the app callback, so call it
     * straight from the click handler. Errors come back to `errorPath`
     * (default: this page) as `?error=...`.
     */
    getAuthorizationUrl(
      input: {
        provider: SocialProvider | WorkOSProviderName;
        errorPath?: string;
      } & StartAuthorizationOptions,
    ): Promise<AuthResult> {
      const provider = socialProvider(input.provider);
      if (isFramed()) return socialInPopup(provider, input);
      const errorPath = input.errorPath ?? location().pathname;
      return authenticate(
        "/sign-in/social",
        {
          provider,
          callbackURL: location().origin,
          errorCallbackURL: new URL(errorPath, location().origin).toString(),
        },
        input,
      );
    },

    /** Sign in with an email address or username, and a password. */
    authenticateWithPassword(
      input: ({ email: string; username?: never } | { username: string; email?: never }) & {
        password: string;
        rememberMe?: boolean;
      } & StartAuthorizationOptions &
        CaptchaOption,
    ): Promise<AuthResult> {
      if (input.username !== undefined) {
        return authenticate(
          "/sign-in/username",
          { username: input.username, password: input.password },
          input,
        );
      }
      return authenticate(
        "/sign-in/email",
        {
          email: input.email,
          password: input.password,
          callbackURL: location().href,
          ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
        },
        { ...input, email: input.email },
      );
    },

    /**
     * Create an account and sign in. With `email`, a password account (8 to
     * 128 characters); it fails with `email_verification_required` when the app
     * requires verification. With `username` or neither (an `auto_generated`
     * username, returned on the result), a username account, when
     * `config.usernameSignUp` is set.
     */
    createUser(
      input: {
        email?: string;
        username?: string;
        password: string;
        name?: string;
      } & StartAuthorizationOptions &
        CaptchaOption,
    ): Promise<AuthResult> {
      if (input.email !== undefined) {
        return authenticate(
          "/sign-up/email",
          {
            email: input.email,
            password: input.password,
            name: input.name ?? "",
            callbackURL: location().href,
          },
          { ...input, email: input.email },
        );
      }
      return authenticate(
        "/sign-up/username",
        {
          password: input.password,
          ...(input.username ? { username: input.username } : {}),
          ...(input.name ? { name: input.name } : {}),
        },
        input,
      );
    },

    /** Email a one-time sign-in code (WorkOS: Magic Auth). */
    sendMagicAuthCode(input: { email: string } & CaptchaOption): Promise<StepResult> {
      return step(
        "/email-otp/send-verification-otp",
        { email: input.email, type: "sign-in" },
        input.captchaToken,
      );
    },

    /** Sign in (or sign up) with the emailed code. */
    authenticateWithMagicAuth(
      input: { email: string; code: string } & StartAuthorizationOptions,
    ): Promise<AuthResult> {
      return authenticate("/sign-in/email-otp", { email: input.email, otp: input.code }, input);
    },

    /**
     * Finish an `email_verification_required` sign-in or sign-up with the
     * emailed code. Signs the user in.
     */
    authenticateWithEmailVerification(
      input: { code: string; pendingAuthenticationToken: string } & StartAuthorizationOptions,
    ): Promise<AuthResult> {
      const pending = decodePending(input.pendingAuthenticationToken);
      if (!pending) return Promise.resolve(failure("invalid_token", "Start signing in again."));
      return authenticate(
        "/email-otp/verify-email",
        { email: pending.email, otp: input.code },
        { ...input, email: pending.email },
      );
    },

    /** Send a new verification code for an `email_verification_required` error. */
    sendVerificationCode(
      input: { pendingAuthenticationToken: string } & CaptchaOption,
    ): Promise<StepResult> {
      const pending = decodePending(input.pendingAuthenticationToken);
      if (!pending) return Promise.resolve(failure("invalid_token", "Start signing in again."));
      return step(
        "/email-otp/send-verification-otp",
        { email: pending.email, type: "email-verification" },
        input.captchaToken,
      );
    },

    /** Text a one-time code to a phone number (E.164). */
    sendSmsCode(input: { phoneNumber: string } & CaptchaOption): Promise<StepResult> {
      return step("/phone-number/send-otp", { phoneNumber: input.phoneNumber }, input.captchaToken);
    },

    /** Sign in (or sign up) with the texted code. */
    authenticateWithSmsCode(
      input: { phoneNumber: string; code: string } & StartAuthorizationOptions & CaptchaOption,
    ): Promise<AuthResult> {
      return authenticate(
        "/phone-number/verify",
        { phoneNumber: input.phoneNumber, code: input.code },
        input,
      );
    },

    /** Whether this browser can use passkeys. */
    isPasskeyAvailable(): boolean {
      return isWebAuthnAvailable();
    },

    /**
     * Sign in with a passkey. `autofill: true` runs conditional mediation, so
     * the browser offers passkeys in an input with `autocomplete="username
     * webauthn"`; call it once when the page mounts. A dismissed prompt fails
     * with `passkey_cancelled`.
     */
    async authenticateWithPasskey(
      input: { autofill?: boolean; signal?: AbortSignal } & StartAuthorizationOptions = {},
    ): Promise<AuthResult> {
      const optionsResult = await request("GET", "/passkey/generate-authenticate-options");
      if (!optionsResult.ok) return optionsResult;
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({
          publicKey: requestOptionsFromJSON(optionsResult.body as Record<string, unknown>),
          ...(input.autofill ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        return failure("passkey_cancelled", error instanceof Error ? error.message : "Cancelled");
      }
      if (!credential) return failure("passkey_cancelled", "No passkey was chosen.");
      return authenticate(
        "/passkey/verify-authentication",
        { response: credentialToJSON(credential as PublicKeyCredential) },
        input,
      );
    },

    /** Email a password reset link to `passwordResetUrl?token=...`. */
    sendPasswordResetEmail(
      input: { email: string; passwordResetUrl: string } & CaptchaOption,
    ): Promise<StepResult> {
      return step(
        "/request-password-reset",
        {
          email: input.email,
          redirectTo: new URL(input.passwordResetUrl, location().origin).toString(),
        },
        input.captchaToken,
      );
    },

    /** Set a new password with the reset link's token. */
    resetPassword(input: { token: string; newPassword: string }): Promise<StepResult> {
      return step("/reset-password", { token: input.token, newPassword: input.newPassword });
    },

    /**
     * Ask the app owner to let an address in after `sign_in_not_allowed`, when
     * `config.accessRequestsEnabled`. Always succeeds, so it cannot be used to
     * probe who is allowed.
     */
    requestAccess(input: { email: string }): Promise<StepResult> {
      return step("/access-request", { email: input.email });
    },

    // --------------------------------------------------------- user management
    //
    // These read the auth session on this origin, which every sign-in here sets.

    /** The signed-in user, or null. */
    async getUser(): Promise<DataResult<User | null>> {
      const result = await read<{ user: User } | null>("/get-session");
      return result.ok ? { ok: true, data: result.data?.user ?? null } : result;
    },

    /**
     * Update the profile, or the password (with `currentPassword`; signs out
     * other sessions). Usernames and email addresses are changed by the app owner.
     */
    async updateUser(input: {
      name?: string;
      image?: string | null;
      password?: string;
      currentPassword?: string;
    }): Promise<StepResult> {
      if (input.password !== undefined) {
        const changed = await step("/change-password", {
          currentPassword: input.currentPassword ?? "",
          newPassword: input.password,
          revokeOtherSessions: true,
        });
        if (!changed.ok) return changed;
      }
      if (input.name === undefined && input.image === undefined) return { ok: true };
      return step("/update-user", {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.image === undefined ? {} : { image: input.image }),
      });
    },

    /**
     * Delete the account and everything Hercules Auth stores for it. Needs a
     * recent sign-in, or the password; otherwise `reauthentication_required`.
     * The app's own data about the user is the app's to delete. Then sign out
     * with the app SDK.
     */
    deleteUser(input: { password?: string } = {}): Promise<StepResult> {
      return step("/delete-user", input.password ? { password: input.password } : {});
    },

    /** End the auth session on this origin. The app SDK's sign-out ends the app session. */
    signOut(): Promise<StepResult> {
      return step("/sign-out", {});
    },

    /** Sign-in methods linked to the user. */
    async listIdentities(): Promise<DataResult<Identity[]>> {
      const result =
        await read<{ id: string; providerId: string; accountId: string; createdAt: string }[]>(
          "/list-accounts",
        );
      if (!result.ok) return result;
      return {
        ok: true,
        data: result.data.map((row) => ({
          id: row.id,
          provider: row.providerId === "credential" ? "password" : row.providerId,
          providerUserId: row.accountId,
          createdAt: row.createdAt,
        })),
      };
    },

    /** Link a social provider; navigate to the result. Returns to `returnTo`. */
    async linkIdentity(input: {
      provider: SocialProvider | WorkOSProviderName;
      returnTo?: string;
    }): Promise<AuthResult> {
      const result = await request("POST", "/link-social", {
        provider: socialProvider(input.provider),
        callbackURL: new URL(input.returnTo ?? location().pathname, location().origin).toString(),
      });
      if (!result.ok) return result;
      const redirectTo = redirectFrom(result.body);
      return redirectTo
        ? { ok: true, redirectTo }
        : failure("unknown_error", "The server returned no redirect.", 200);
    },

    /** Unlink a sign-in method by its `Identity.id`. */
    unlinkIdentity(input: { identityId: string }): Promise<StepResult> {
      return step("/unlink-account", { accountId: input.identityId });
    },

    /** The user's passkeys. */
    async listPasskeys(): Promise<DataResult<Passkey[]>> {
      const result = await read<Passkey[]>("/passkey/list-user-passkeys");
      return result.ok
        ? {
            ok: true,
            data: result.data.map((row) => ({ ...row, name: row.name ?? null })),
          }
        : result;
    },

    /** Add a passkey for this device. Needs a recent sign-in (`reauthentication_required`). */
    async createPasskey(input: { name?: string } = {}): Promise<StepResult> {
      const query = input.name ? `?name=${encodeURIComponent(input.name)}` : "";
      const optionsResult = await request("GET", `/passkey/generate-register-options${query}`);
      if (!optionsResult.ok) return optionsResult;
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({
          publicKey: creationOptionsFromJSON(optionsResult.body as Record<string, unknown>),
        });
      } catch (error) {
        return failure("passkey_cancelled", error instanceof Error ? error.message : "Cancelled");
      }
      if (!credential) return failure("passkey_cancelled", "No passkey was created.");
      return step("/passkey/verify-registration", {
        response: credentialToJSON(credential as PublicKeyCredential),
        ...(input.name ? { name: input.name } : {}),
      });
    },

    /** Remove a passkey by `Passkey.id`. */
    deletePasskey(input: { passkeyId: string }): Promise<StepResult> {
      return step("/passkey/delete-passkey", { id: input.passkeyId });
    },

    /** The user's signed-in devices. */
    async listSessions(): Promise<DataResult<Session[]>> {
      const result = await listSessionRows();
      if (!result.ok) return result;
      return {
        ok: true,
        data: result.data.map(({ id, createdAt, expiresAt, ipAddress, userAgent }) => ({
          id,
          createdAt,
          expiresAt,
          ipAddress: ipAddress ?? null,
          userAgent: userAgent ?? null,
        })),
      };
    },

    /** Sign out one device by `Session.id`. */
    async revokeSession(input: { sessionId: string }): Promise<StepResult> {
      if (!sessionTokens.has(input.sessionId)) {
        const listed = await listSessionRows();
        if (!listed.ok) return listed;
      }
      const token = sessionTokens.get(input.sessionId);
      if (!token) return failure("invalid_request", "That session no longer exists.");
      const result = await step("/revoke-session", { token });
      if (result.ok) sessionTokens.delete(input.sessionId);
      return result;
    },

    /** Sign out every device but this one. */
    revokeOtherSessions(): Promise<StepResult> {
      return step("/revoke-other-sessions", {});
    },
  };
}

export type EmbeddedAuthClient = ReturnType<typeof createEmbeddedAuthClient>;
