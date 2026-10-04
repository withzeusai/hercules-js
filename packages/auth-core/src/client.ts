import {
  creationOptionsFromJSON,
  credentialToJSON,
  isWebAuthnAvailable,
  requestOptionsFromJSON,
} from "./webauthn";

/**
 * Embedded sign-in client.
 *
 * When a Hercules app renders its own sign-in UI, the platform serves the app's
 * auth API on the app's own origin under {@link DEFAULT_AUTH_BASE_PATH}. This
 * client calls it. Every sign-in finishes the way the hosted portal's does: the
 * request carries the signed authorization query (`oauth_query`), the server
 * completes the OIDC authorize step in the same response, and the result is a
 * redirect to the app's `/auth/callback?code=...`. Navigating there lets the
 * app's existing SDK exchange the code and start its session, so nothing
 * downstream of sign-in changes.
 *
 * The signed query comes from one of two places:
 *
 * - The current URL, when the authorize endpoint sent the visitor to this page
 *   (a protected page, `SignInButton`, `/auth/sign-in`).
 * - A fresh authorization request, when the sign-in starts anywhere else, such
 *   as a "Continue with Google" button on a landing page. The framework adapter
 *   supplies `startAuthorization`, which begins a PKCE flow and returns the
 *   authorize URL; the client asks it for the signed query without navigating.
 */

/** Where the platform serves the app's auth API on its own origin. */
export const DEFAULT_AUTH_BASE_PATH = "/_hercules/auth";

export type SocialProvider = "google" | "apple" | "microsoft" | "facebook" | "linkedin";

export type SignInMethod =
  | SocialProvider
  | "email_otp"
  | "email_password"
  | "phone_otp"
  | "username_password";

/** The tenant's public sign-in settings, as `/config` returns them. */
export interface SignInConfig {
  /** The OIDC issuer; pass it to `mountTurnstileBridge`. */
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
  /** Whether a password sign-up must click an emailed link before signing in. */
  requireEmailVerification: boolean;
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
   * origin. Supplied by the framework adapter (`@usehercules/auth-tanstack`,
   * `@usehercules/auth`); needed only to start a sign-in from a page the
   * authorize endpoint did not send the visitor to.
   */
  startAuthorization?: (options: StartAuthorizationOptions) => Promise<string>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `window.location`. */
  location?: Pick<Location, "origin" | "search" | "pathname" | "href" | "assign">;
  /**
   * Whether the app runs inside a frame (the dashboard preview). Social
   * sign-in then runs in a popup, since providers refuse to be framed.
   * Defaults to checking `window.top`.
   */
  isFramed?: () => boolean;
}

export interface AuthError {
  /**
   * Machine-readable code, e.g. `INVALID_EMAIL_OR_PASSWORD`,
   * `SIGN_IN_NOT_ALLOWLISTED`, `EMAIL_NOT_VERIFIED`, `access_denied`.
   */
  code: string;
  message: string;
  status: number;
  /** The address the allowlist turned away, when the server named it. */
  rejectedEmail?: string;
}

/**
 * What a sign-in produced: somewhere to go next (the app callback with a code,
 * or a social provider's consent page), a sign-up that must verify its email
 * first, or a failure.
 */
export type AuthResult =
  | {
      ok: true;
      status: "redirect";
      redirectTo: string;
      /** The username an auto-generated username sign-up was assigned. */
      username?: string;
    }
  | { ok: true; status: "verify-email" }
  | { ok: false; error: AuthError };

/** The outcome of a step that does not sign anyone in, such as sending a code. */
export type StepResult = { ok: true } | { ok: false; error: AuthError };

/** The outcome of a read. */
export type DataResult<T> = { ok: true; data: T } | { ok: false; error: AuthError };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
  username?: string | null;
  phoneNumber?: string | null;
}

export interface LinkedAccount {
  /** Pass to `unlinkAccount`. */
  id: string;
  /** `credential` for a password, otherwise the provider (`google`, ...). */
  providerId: string;
  accountId: string;
  createdAt: string;
}

export interface Passkey {
  id: string;
  name?: string | null;
  createdAt: string;
  deviceType?: string;
}

interface SignInStartOptions extends StartAuthorizationOptions {
  /** Cloudflare Turnstile token, for the endpoints that require one. */
  captchaToken?: string;
}

/** The signed parameters `authorize` hands the sign-in page. */
type SignedQuery = { query: string } | { signedIn: string };

/** Signed-query bookkeeping the authorize endpoint adds; not authorize parameters. */
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_POLL_MS = 500;

const NO_AUTHORIZATION: AuthError = {
  code: "NO_AUTHORIZATION_REQUEST",
  message:
    "This page has no sign-in request to complete. Open it through the app's sign-in link, or pass startAuthorization.",
  status: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string, status = 0): { ok: false; error: AuthError } {
  return { ok: false, error: { code, message, status } };
}

/**
 * The signed authorize query in `search`, or null when the page was not opened
 * by the authorize endpoint. Only the presence of `sig` is checked here; the
 * server verifies it.
 */
export function readSignedQuery(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(query).has("sig") ? query : null;
}

/**
 * The error the authorize endpoint or a social callback put on the page URL
 * (`?error=...`), so the sign-in page can show it.
 */
export function readAuthError(search: string): AuthError | null {
  const params = new URLSearchParams(search);
  const code = params.get("error");
  if (!code) return null;
  const rejectedEmail = params.get("rejected_email");
  return {
    code,
    message: params.get("error_description") ?? code,
    status: 0,
    ...(rejectedEmail ? { rejectedEmail } : {}),
  };
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

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    captchaToken?: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: AuthError }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
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
      return failure("NETWORK_ERROR", error instanceof Error ? error.message : "Network error");
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
      return { ok: false, error: { code, message, status: response.status } };
    }
    return { ok: true, body: parsed };
  }

  /** The `url` of a `{ redirect: true, url }` body, resolved on this origin. */
  function redirectFrom(body: unknown): string | null {
    if (!isRecord(body) || typeof body.url !== "string") return null;
    return new URL(body.url, location().origin).toString();
  }

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
    // A fetch (not a navigation) makes authorize answer `{ redirect, url }`
    // instead of a 302, so the page can stay put.
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
   * sign-in page instead of the app: with `prompt=create` it lands on the
   * sign-up page. `/oauth2/continue` acknowledges that step and returns the
   * code redirect, as the hosted portal does.
   */
  async function finishAuthorization(target: string, query: string): Promise<AuthResult> {
    if (!readSignedQuery(new URL(target).search)) {
      return { ok: true, status: "redirect", redirectTo: target };
    }
    const prompt = new URLSearchParams(query).get("prompt") ?? "";
    const result = await request("POST", "/oauth2/continue", {
      ...(prompt.includes("create") ? { created: true } : { selected: true }),
      oauth_query: query,
    });
    if (!result.ok) return result;
    const redirectTo = redirectFrom(result.body);
    return redirectTo
      ? { ok: true, status: "redirect", redirectTo }
      : failure("NO_REDIRECT", "Sign-in succeeded but the server returned no redirect.", 200);
  }

  /** Run a session-creating request with the signed query attached. */
  async function signIn(
    path: string,
    body: Record<string, unknown>,
    start: SignInStartOptions,
  ): Promise<AuthResult> {
    const signed = await signedQuery(start);
    if (!signed) return { ok: false, error: NO_AUTHORIZATION };
    if ("signedIn" in signed) return { ok: true, status: "redirect", redirectTo: signed.signedIn };

    const result = await request(
      "POST",
      path,
      { ...body, oauth_query: signed.query },
      start.captchaToken,
    );
    if (!result.ok) return result;
    const target = redirectFrom(result.body);
    const username =
      isRecord(result.body) && typeof result.body.username === "string"
        ? result.body.username
        : undefined;
    if (!target) {
      // A password sign-up that must verify its email gets no session yet.
      if (isRecord(result.body) && result.body.token == null && isRecord(result.body.user)) {
        return { ok: true, status: "verify-email" };
      }
      return failure("NO_REDIRECT", "Sign-in succeeded but the server returned no redirect.", 200);
    }
    const finished = await finishAuthorization(target, signed.query);
    return finished.ok && finished.status === "redirect" && username
      ? { ...finished, username }
      : finished;
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
      return failure("POPUP_BLOCKED", "Allow pop-ups for this site to sign in with this provider.");
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
      return { ok: true, status: "redirect", redirectTo: signed.signedIn };
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
      if (claimed.error.status === 404) {
        return failure("POPUP_CLOSED", "Sign-in was not completed.", 404);
      }
      return claimed;
    }
    const body = claimed.body;
    if (isRecord(body) && typeof body.redirectUrl === "string") {
      return { ok: true, status: "redirect", redirectTo: body.redirectUrl };
    }
    return failure("NO_REDIRECT", "Sign-in succeeded but the server returned no redirect.", 200);
  }

  return {
    // ----------------------------------------------------------------- page

    /** Whether the authorize endpoint opened this page with a sign-in to complete. */
    hasPendingSignIn(): boolean {
      return readSignedQuery(location().search) !== null;
    },

    /** Whether the authorize endpoint sent the visitor here to create an account. */
    isSignUpRequest(): boolean {
      const params = new URLSearchParams(location().search);
      return params.get("prompt") === "create" || params.get("screen_hint") === "sign-up";
    },

    /** An error the server put on this page's URL, if any. */
    pageError(): AuthError | null {
      return readAuthError(location().search);
    },

    /** Navigate to a redirect result. */
    navigate(result: Extract<AuthResult, { status: "redirect" }>): void {
      location().assign(result.redirectTo);
    },

    /** The app's public sign-in settings: enabled methods, branding, sign-up options. */
    getConfig(): Promise<DataResult<SignInConfig>> {
      return read<SignInConfig>("/config");
    },

    // ------------------------------------------------------------ email code

    /** Email a one-time sign-in code. Requires a captcha token. */
    sendEmailOtp(input: { email: string; captchaToken?: string }): Promise<StepResult> {
      return step(
        "/email-otp/send-verification-otp",
        { email: input.email, type: "sign-in" },
        input.captchaToken,
      );
    },

    /** Sign in (or sign up) with the emailed code. No captcha. */
    signInWithEmailOtp(
      input: { email: string; otp: string } & StartAuthorizationOptions,
    ): Promise<AuthResult> {
      return signIn("/sign-in/email-otp", { email: input.email, otp: input.otp }, input);
    },

    // ------------------------------------------------------- email password

    /** Sign in with an email address and password. Requires a captcha token. */
    signInWithPassword(
      input: { email: string; password: string; rememberMe?: boolean } & SignInStartOptions,
    ): Promise<AuthResult> {
      return signIn(
        "/sign-in/email",
        {
          email: input.email,
          password: input.password,
          // Where the verification link returns when the email is unverified.
          callbackURL: location().href,
          ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
        },
        input,
      );
    },

    /**
     * Create an account with an email address and password (8 to 128
     * characters). Requires a captcha token. Resolves `verify-email` when the
     * app requires email verification: the user signs in after clicking the
     * emailed link, which returns to this page.
     */
    signUpWithPassword(
      input: { email: string; password: string; name?: string } & SignInStartOptions,
    ): Promise<AuthResult> {
      return signIn(
        "/sign-up/email",
        {
          email: input.email,
          password: input.password,
          name: input.name ?? "",
          callbackURL: location().href,
        },
        input,
      );
    },

    /** Email a password reset link that returns to `resetPath` with `?token=`. Requires a captcha token. */
    requestPasswordReset(input: {
      email: string;
      resetPath: string;
      captchaToken?: string;
    }): Promise<StepResult> {
      return step(
        "/request-password-reset",
        {
          email: input.email,
          redirectTo: new URL(input.resetPath, location().origin).toString(),
        },
        input.captchaToken,
      );
    },

    /** Set a new password with the reset link's token. No captcha. */
    resetPassword(input: { token: string; newPassword: string }): Promise<StepResult> {
      return step("/reset-password", { token: input.token, newPassword: input.newPassword });
    },

    // --------------------------------------------------------------- username

    /** Sign in with a username and password. Requires a captcha token. */
    signInWithUsername(
      input: { username: string; password: string } & SignInStartOptions,
    ): Promise<AuthResult> {
      return signIn(
        "/sign-in/username",
        { username: input.username, password: input.password },
        input,
      );
    },

    /**
     * Create a username account (when `config.usernameSignUp` is set). Pass
     * `username` only in `user_chosen` mode; in `auto_generated` mode the
     * result carries the assigned `username` to show the user. Requires a
     * captcha token.
     */
    signUpWithUsername(
      input: { password: string; username?: string; name?: string } & SignInStartOptions,
    ): Promise<AuthResult> {
      return signIn(
        "/sign-up/username",
        {
          password: input.password,
          ...(input.username ? { username: input.username } : {}),
          ...(input.name ? { name: input.name } : {}),
        },
        input,
      );
    },

    // ------------------------------------------------------------------ phone

    /** Text a one-time code to a phone number (E.164). Requires a captcha token. */
    sendPhoneOtp(input: { phoneNumber: string; captchaToken?: string }): Promise<StepResult> {
      return step("/phone-number/send-otp", { phoneNumber: input.phoneNumber }, input.captchaToken);
    },

    /** Sign in with the texted code. Requires a captcha token. */
    signInWithPhoneOtp(
      input: { phoneNumber: string; code: string } & SignInStartOptions,
    ): Promise<AuthResult> {
      return signIn(
        "/phone-number/verify",
        { phoneNumber: input.phoneNumber, code: input.code },
        input,
      );
    },

    // ----------------------------------------------------------------- social

    /**
     * Sign in with a social provider. Top-level, the result's `redirectTo` is
     * the provider's consent page; navigate there, and the provider returns
     * through the platform to the app callback. Inside a frame it runs in a
     * popup and resolves to the app callback; call it directly from the click
     * handler so the popup is allowed. Errors come back to `errorPath`
     * (default: this page) as `?error=...`.
     */
    signInWithSocial(
      input: { provider: SocialProvider; errorPath?: string } & StartAuthorizationOptions,
    ): Promise<AuthResult> {
      if (isFramed()) return socialInPopup(input.provider, input);
      const errorPath = input.errorPath ?? location().pathname;
      return signIn(
        "/sign-in/social",
        {
          provider: input.provider,
          callbackURL: location().origin,
          errorCallbackURL: new URL(errorPath, location().origin).toString(),
        },
        input,
      );
    },

    // ---------------------------------------------------------------- passkey

    /** Whether this browser can use passkeys. */
    isPasskeyAvailable(): boolean {
      return isWebAuthnAvailable();
    },

    /**
     * Sign in with a passkey. `autofill: true` runs conditional mediation, so
     * the browser offers passkeys in an input with `autocomplete="username
     * webauthn"`; call it once when the page mounts. A dismissed prompt
     * resolves `PASSKEY_CANCELLED`.
     */
    async signInWithPasskey(
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
        return failure("PASSKEY_CANCELLED", error instanceof Error ? error.message : "Cancelled");
      }
      if (!credential) return failure("PASSKEY_CANCELLED", "No passkey was chosen.");
      return signIn(
        "/passkey/verify-authentication",
        { response: credentialToJSON(credential as PublicKeyCredential) },
        input,
      );
    },

    // ----------------------------------------------------------------- access

    /**
     * Ask the app owner to let an address in after the allowlist turned it
     * away (`SIGN_IN_NOT_ALLOWLISTED`), when `config.accessRequestsEnabled`.
     * Always succeeds, so it cannot be used to probe the allowlist.
     */
    requestAccess(input: { email: string }): Promise<StepResult> {
      return step("/access-request", { email: input.email });
    },

    // ---------------------------------------------------------------- account
    //
    // Account management reads the auth session on this origin, which every
    // embedded sign-in sets. Pages that use these sit behind the app's own
    // signed-in check.

    /** The signed-in user, or null. */
    async getSession(): Promise<DataResult<{ user: SessionUser } | null>> {
      return read<{ user: SessionUser } | null>("/get-session");
    },

    /** End the auth session on this origin. The app's SDK sign-out ends the app session. */
    signOut(): Promise<StepResult> {
      return step("/sign-out", {});
    },

    /** Sign-in methods linked to the account. */
    listAccounts(): Promise<DataResult<LinkedAccount[]>> {
      return read<LinkedAccount[]>("/list-accounts");
    },

    /** Link a social provider; navigate to the result's `redirectTo`. Returns to `returnPath`. */
    async linkSocial(input: {
      provider: SocialProvider;
      returnPath?: string;
    }): Promise<DataResult<{ redirectTo: string }>> {
      const result = await request("POST", "/link-social", {
        provider: input.provider,
        callbackURL: new URL(input.returnPath ?? location().pathname, location().origin).toString(),
      });
      if (!result.ok) return result;
      const redirectTo = redirectFrom(result.body);
      return redirectTo
        ? { ok: true, data: { redirectTo } }
        : failure("NO_REDIRECT", "The server returned no redirect.", 200);
    },

    /** Unlink a sign-in method by its `LinkedAccount.id`. */
    unlinkAccount(input: { accountId: string }): Promise<StepResult> {
      return step("/unlink-account", { accountId: input.accountId });
    },

    /** Change the password of an account that has one. Signs out other sessions. */
    changePassword(input: { currentPassword: string; newPassword: string }): Promise<StepResult> {
      return step("/change-password", {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      });
    },

    /** The account's passkeys. */
    listPasskeys(): Promise<DataResult<Passkey[]>> {
      return read<Passkey[]>("/passkey/list-user-passkeys");
    },

    /**
     * Add a passkey for this device. Needs a recent sign-in; an older session
     * fails with `SESSION_NOT_FRESH`, and the user signs in again first.
     */
    async addPasskey(input: { name?: string } = {}): Promise<StepResult> {
      const query = input.name ? `?name=${encodeURIComponent(input.name)}` : "";
      const optionsResult = await request("GET", `/passkey/generate-register-options${query}`);
      if (!optionsResult.ok) return optionsResult;
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({
          publicKey: creationOptionsFromJSON(optionsResult.body as Record<string, unknown>),
        });
      } catch (error) {
        return failure("PASSKEY_CANCELLED", error instanceof Error ? error.message : "Cancelled");
      }
      if (!credential) return failure("PASSKEY_CANCELLED", "No passkey was created.");
      return step("/passkey/verify-registration", {
        response: credentialToJSON(credential as PublicKeyCredential),
        ...(input.name ? { name: input.name } : {}),
      });
    },

    /** Remove a passkey by id. */
    deletePasskey(input: { id: string }): Promise<StepResult> {
      return step("/passkey/delete-passkey", { id: input.id });
    },
  };
}

export type EmbeddedAuthClient = ReturnType<typeof createEmbeddedAuthClient>;
