/**
 * Failure-only client auth diagnostics.
 *
 * Reports browser-side auth failures to Hercules so we can debug sign-in
 * issues that never surface clearly in server logs. Successful sign-ins are
 * never reported. See the design doc for the full contract.
 */

const DEFAULT_DIAGNOSTICS_ENDPOINT = "/_hercules/report";
const ATTEMPT_ID_STORAGE_KEY = "_hrc_auth_attempt";
const DEDUPE_WINDOW_MS = 60_000;
const MAX_ERROR_MESSAGE_LEN = 500;
const MAX_STRING_FIELD_LEN = 256;

/**
 * Phases at which client auth can fail. New phases must be reflected in the
 * backend classifier so events stay searchable by stable category.
 * @public
 */
export type AuthDiagnosticPhase =
  | "signin-redirect-failed"
  | "oidc-error"
  | "callback-not-authenticated"
  | "callback-timeout"
  | "backend-sync-failed";

/**
 * Normalized error class. Derived deterministically from the underlying error
 * so server-side classification can rely on it. Raw error messages are
 * untrusted (may include user-installed strings) and are sanitized separately.
 * @public
 */
export type AuthDiagnosticErrorClass =
  | "failed_fetch"
  | "missing_oidc_state"
  | "issuer_mismatch"
  | "callback_timeout"
  | "backend_sync_failed"
  | "storage_unavailable"
  | "oidc_provider_error"
  | "unknown";

/**
 * Payload sent to the diagnostics endpoint. All fields are optional except
 * `phase` and `authAttemptId` so callers can report partial information when
 * the browser context is degraded.
 * @public
 */
export interface AuthDiagnosticEvent {
  phase: AuthDiagnosticPhase;
  authAttemptId: string;
  errorClass: AuthDiagnosticErrorClass;
  origin?: string;
  pathname?: string;
  authorityHost?: string;
  metadataIssuer?: string;
  tokenEndpointHost?: string;
  clientId?: string;
  redirectUriOrigin?: string;
  redirectUriPath?: string;
  hasCode?: boolean;
  hasState?: boolean;
  hasErrorParam?: boolean;
  iss?: string;
  errorName?: string;
  errorMessage?: string;
  appBuildId?: string;
  online?: boolean;
  serviceWorkerControlled?: boolean;
  storageAvailable?: boolean;
  documentVisibilityState?: string;
}

/**
 * SDK configuration for diagnostics. All fields optional; sensible defaults
 * report to the same-origin `/_hercules/report` endpoint.
 * @public
 */
export interface DiagnosticsConfig {
  /** Whether diagnostics are created at all. Defaults to true. */
  enabled?: boolean;
  /** Whether diagnostics are sent over the network. Defaults to true. */
  reportToHercules?: boolean;
  /** Override the diagnostics endpoint. Defaults to `/_hercules/report`. */
  endpoint?: string;
  /** Observer fired for every diagnostic event regardless of network reporting. */
  onDiagnostic?: (event: AuthDiagnosticEvent) => void;
  /** Optional app build identifier surfaced in the payload. */
  appBuildId?: string;
}

interface ResolvedDiagnosticsConfig {
  enabled: boolean;
  reportToHercules: boolean;
  endpoint: string;
  onDiagnostic: ((event: AuthDiagnosticEvent) => void) | undefined;
  appBuildId: string | undefined;
}

function resolveConfig(config: DiagnosticsConfig | undefined): ResolvedDiagnosticsConfig {
  return {
    enabled: config?.enabled ?? true,
    reportToHercules: config?.reportToHercules ?? true,
    endpoint: config?.endpoint ?? DEFAULT_DIAGNOSTICS_ENDPOINT,
    onDiagnostic: config?.onDiagnostic,
    appBuildId: config?.appBuildId,
  };
}

let inMemoryAttemptId: string | undefined;
let storageBroken = false;

function randomAttemptId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to fallback
  }
  // Non-cryptographic fallback. Acceptable: attempt IDs are correlation
  // identifiers, not security tokens.
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function tryReadStorage(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch {
    storageBroken = true;
    return null;
  }
}

function tryWriteStorage(key: string, value: string): boolean {
  try {
    if (typeof sessionStorage === "undefined") {
      storageBroken = true;
      return false;
    }
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    storageBroken = true;
    return false;
  }
}

function tryDeleteStorage(key: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(key);
  } catch {
    storageBroken = true;
  }
}

/**
 * Returns the current auth attempt ID, generating one if none exists yet.
 * Persists to sessionStorage so the callback page can correlate with the
 * start of the flow; if storage is unavailable, the attempt ID lives in
 * memory and `storageAvailable: false` is reported in diagnostics.
 * @public
 */
export function getOrCreateAuthAttemptId(): string {
  const fromStorage = tryReadStorage(ATTEMPT_ID_STORAGE_KEY);
  if (fromStorage) {
    inMemoryAttemptId = fromStorage;
    return fromStorage;
  }

  if (inMemoryAttemptId) {
    // Make a best-effort second write in case storage recovered.
    tryWriteStorage(ATTEMPT_ID_STORAGE_KEY, inMemoryAttemptId);
    return inMemoryAttemptId;
  }

  const id = randomAttemptId();
  inMemoryAttemptId = id;
  tryWriteStorage(ATTEMPT_ID_STORAGE_KEY, id);
  return id;
}

/**
 * Clears the persisted attempt ID. Called after a successful sign-in flow so
 * the next attempt gets a fresh correlation ID.
 * @public
 */
export function clearAuthAttemptId(): void {
  inMemoryAttemptId = undefined;
  tryDeleteStorage(ATTEMPT_ID_STORAGE_KEY);
}

/**
 * Returns true if sessionStorage access has worked at least once for the
 * attempt-id key in this tab. Distinct from "storage exists" — a Safari
 * private-mode tab will surface as `false` here even though `sessionStorage`
 * is defined.
 */
function isStorageAvailable(): boolean {
  return !storageBroken && typeof sessionStorage !== "undefined";
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function looksLikeFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // "TypeError: Failed to fetch" (Chrome), "NetworkError when attempting…" (Firefox),
  // "Load failed" (Safari) are the canonical network-failure messages.
  const name = err.name;
  if (name === "TypeError" || name === "NetworkError") {
    return /fetch|network|load failed|networkerror/i.test(err.message);
  }
  return false;
}

/**
 * Classifies an arbitrary thrown value into a stable bucket. Used both
 * client-side (for dedupe keys) and server-side (for log indexing).
 * @public
 */
export function classifyAuthError(err: unknown, phase: AuthDiagnosticPhase): AuthDiagnosticErrorClass {
  if (phase === "callback-timeout") return "callback_timeout";
  if (phase === "backend-sync-failed") return "backend_sync_failed";

  if (looksLikeFetchError(err)) return "failed_fetch";

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("no matching state") ||
      msg.includes("state not found") ||
      msg.includes("missing state") ||
      msg.includes("state mismatch")
    ) {
      return "missing_oidc_state";
    }
    if (
      msg.includes("issuer") &&
      (msg.includes("mismatch") || msg.includes("does not match") || msg.includes("invalid issuer"))
    ) {
      return "issuer_mismatch";
    }
    if (phase === "oidc-error") return "oidc_provider_error";
  }

  if (phase === "callback-not-authenticated") return "missing_oidc_state";
  return "unknown";
}

// Map values are expiry timestamps. The cache is bounded in practice by
// the number of distinct (phase, errorClass, authorityHost, hasCode,
// hasState) tuples that fail in a tab session, which is small.
const dedupeCache = new Map<string, number>();

/**
 * Returns true if an event matching the given key has already been reported
 * within the dedupe window. The key intentionally excludes raw error
 * messages to avoid unstable-text defeating dedupe.
 */
function shouldDedupe(key: string, now: number): boolean {
  const expiresAt = dedupeCache.get(key);
  if (expiresAt != null && expiresAt > now) return true;
  dedupeCache.set(key, now + DEDUPE_WINDOW_MS);
  return false;
}

function dedupeKey(event: AuthDiagnosticEvent): string {
  return [
    event.phase,
    event.errorClass,
    event.authorityHost ?? "",
    event.hasCode ? "1" : "0",
    event.hasState ? "1" : "0",
  ].join("|");
}

/**
 * Resets the in-process dedupe cache. Intended for tests.
 * @internal
 */
export function __resetDiagnosticsState(): void {
  dedupeCache.clear();
  inMemoryAttemptId = undefined;
  storageBroken = false;
}

interface CollectContextOptions {
  authority?: string;
  clientId?: string;
  redirectUri?: string;
  metadataIssuer?: string;
  tokenEndpoint?: string;
}

/**
 * Reads ambient browser state that is safe to ship. We intentionally avoid
 * the full user agent, the full URL, query params, and storage contents.
 */
function collectBrowserContext(options: CollectContextOptions): Omit<AuthDiagnosticEvent, "phase" | "authAttemptId" | "errorClass"> {
  const event: Omit<AuthDiagnosticEvent, "phase" | "authAttemptId" | "errorClass"> = {};

  if (typeof window !== "undefined" && window.location) {
    event.origin = window.location.origin;
    event.pathname = window.location.pathname;

    const params = new URLSearchParams(window.location.search);
    event.hasCode = params.has("code");
    event.hasState = params.has("state");
    event.hasErrorParam = params.has("error");
    const iss = params.get("iss");
    if (iss) event.iss = truncate(iss, MAX_STRING_FIELD_LEN);
  }

  event.authorityHost = hostOf(options.authority);
  event.metadataIssuer = truncate(options.metadataIssuer, MAX_STRING_FIELD_LEN);
  event.tokenEndpointHost = hostOf(options.tokenEndpoint);
  event.clientId = truncate(options.clientId, MAX_STRING_FIELD_LEN);
  event.redirectUriOrigin = originOf(options.redirectUri);
  event.redirectUriPath = pathOf(options.redirectUri);

  if (typeof navigator !== "undefined") {
    event.online = typeof navigator.onLine === "boolean" ? navigator.onLine : undefined;
    try {
      event.serviceWorkerControlled = navigator.serviceWorker?.controller != null;
    } catch {
      // some browsers throw on serviceWorker access in insecure contexts
    }
  }
  if (typeof document !== "undefined") {
    event.documentVisibilityState = document.visibilityState;
  }

  event.storageAvailable = isStorageAvailable();
  return event;
}

interface CreateDiagnosticInput {
  phase: AuthDiagnosticPhase;
  error?: unknown;
  authority?: string;
  clientId?: string;
  redirectUri?: string;
  metadataIssuer?: string;
  tokenEndpoint?: string;
  /** Override for the attempt id (e.g. when caller already resolved one). */
  attemptId?: string;
  appBuildId?: string;
  /**
   * OIDC state-store availability (localStorage probe at provider mount).
   * Distinct from the diagnostics module's own sessionStorage check — both
   * can fail independently. If either is false, the event reports
   * `storageAvailable: false` so we can search for OIDC-storage-broken
   * failures specifically.
   */
  oidcStorageAvailable?: boolean;
}

/**
 * Describes the thrown value safely. Privacy rule: never serialize the
 * thrown value itself, because `onSync()` and other customer-provided
 * callbacks can throw arbitrary objects that may carry tokens, headers,
 * or request bodies. We only trust:
 *   - real `Error` instances → name + message (both truncated)
 *   - everything else → record the constructor name only, no payload
 *
 * Even thrown strings are excluded: `throw "auth failed: token=" + t` is a
 * known anti-pattern and we'd rather lose context than leak a token.
 */
function describeError(err: unknown): { name?: string; message?: string } {
  if (err == null) return {};
  if (err instanceof Error) {
    return {
      name: truncate(err.name, MAX_STRING_FIELD_LEN),
      message: truncate(err.message, MAX_ERROR_MESSAGE_LEN),
    };
  }
  if (typeof err === "string") {
    return { name: "ThrownString" };
  }
  if (typeof err === "object") {
    const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
    return { name: truncate(ctor ?? "ThrownObject", MAX_STRING_FIELD_LEN) };
  }
  return { name: truncate(`Thrown<${typeof err}>`, MAX_STRING_FIELD_LEN) };
}

function buildEvent(input: CreateDiagnosticInput): AuthDiagnosticEvent {
  const attemptId = input.attemptId ?? getOrCreateAuthAttemptId();
  const errorClass = classifyAuthError(input.error, input.phase);
  const ctx = collectBrowserContext({
    authority: input.authority,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    metadataIssuer: input.metadataIssuer,
    tokenEndpoint: input.tokenEndpoint,
  });
  const { name, message } = describeError(input.error);

  // Storage is considered available iff BOTH our sessionStorage (for the
  // attempt id) and the caller-supplied OIDC localStorage probe pass.
  // If either is broken, the failure-investigation answer the user needs
  // is the same: "browser storage was unavailable" — collapsing both into
  // one boolean keeps the bucket simple to search on.
  const sessionStorageOk = ctx.storageAvailable !== false;
  const oidcStorageOk = input.oidcStorageAvailable !== false;
  const storageAvailable = sessionStorageOk && oidcStorageOk;

  return {
    ...ctx,
    phase: input.phase,
    authAttemptId: attemptId,
    errorClass,
    errorName: name,
    errorMessage: message,
    appBuildId: input.appBuildId ?? ctx.appBuildId,
    storageAvailable,
  };
}

function sendEvent(endpoint: string, event: AuthDiagnosticEvent): void {
  const body = JSON.stringify(event);
  try {
    // text/plain avoids the cross-origin preflight that would mask exactly
    // the network/CORS failures we are trying to observe.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      const queued = navigator.sendBeacon(endpoint, blob);
      if (queued) return;
    }
  } catch {
    // fall through to fetch
  }

  if (typeof fetch !== "function") return;

  try {
    void fetch(endpoint, {
      method: "POST",
      body,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      credentials: "omit",
      keepalive: true,
    }).catch(() => {
      // swallowed: diagnostic reporting must never throw
    });
  } catch {
    // swallowed: diagnostic reporting must never throw
  }
}

/**
 * Creates and (best-effort) reports a diagnostic event. Never throws.
 * Never blocks the caller — the network send is fire-and-forget.
 * @public
 */
export function reportAuthDiagnostic(
  config: DiagnosticsConfig | undefined,
  input: CreateDiagnosticInput,
): void {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  let event: AuthDiagnosticEvent;
  try {
    event = buildEvent({ ...input, appBuildId: input.appBuildId ?? resolved.appBuildId });
  } catch {
    // If event construction itself throws, we have no payload to send.
    return;
  }

  const now = Date.now();
  if (shouldDedupe(dedupeKey(event), now)) {
    return;
  }

  try {
    resolved.onDiagnostic?.(event);
  } catch {
    // observer errors must not impair reporting
  }

  if (!resolved.reportToHercules) return;
  sendEvent(resolved.endpoint, event);
}

/**
 * Marks the next sign-in attempt as fresh by clearing the previously stored
 * attempt id and creating a new one. Called immediately before the redirect
 * to the IdP so the callback page sees a new correlation id.
 * @public
 */
export function startAuthAttempt(): string {
  clearAuthAttemptId();
  return getOrCreateAuthAttemptId();
}
