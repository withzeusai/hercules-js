import { serializeCookie, type CookieOptions } from "./cookie-utils";
import { fromBase64Url, toBase64Url } from "./encoding";

/** Default base name of the (chunked) sealed session cookie. */
export const SESSION_COOKIE = "hercules_session";
/**
 * Overrides for the session cookie's base name, tried in order. Useful when two
 * apps on one host must keep separate sessions.
 */
const COOKIE_NAME_ENV_VARS = ["HERCULES_AUTH_COOKIE_NAME", "AUTH_COOKIE_NAME"] as const;

/** Base name of the session cookie: the environment override or {@link SESSION_COOKIE}. */
export function sessionCookieBase(): string {
  for (const name of COOKIE_NAME_ENV_VARS) {
    const value = process.env[name];
    if (value) return value;
  }
  return SESSION_COOKIE;
}
/**
 * Password used to derive the session-sealing key. Accepted variable names,
 * tried in order: the canonical `HERCULES_AUTH_*` name, then the unprefixed
 * `AUTH_*` name as a last resort.
 */
const COOKIE_PASSWORD_ENV_VARS = ["HERCULES_AUTH_COOKIE_PASSWORD", "AUTH_COOKIE_PASSWORD"] as const;
/** Minimum password length. */
const MIN_PASSWORD_LENGTH = 32;
/**
 * Max characters per cookie chunk value. Browsers cap a single cookie at ~4 KB
 * including name and attributes, and a sealed session (access + id + refresh
 * tokens) easily exceeds that, so the value is split across `${SESSION_COOKIE}.0`,
 * `.1`, … and reassembled on read.
 */
const MAX_CHUNK_LENGTH = 3072;

const PBKDF2_ITERATIONS = 100_000;
const KEY_SALT = new TextEncoder().encode("hercules-auth-tanstack/session/v1");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The server-side session sealed into the session cookie. Identity claims are
 * recovered from {@link idToken}/{@link accessToken} on read rather than stored
 * separately, keeping the sealed payload small.
 */
export interface SessionData {
  /** OAuth 2.0 access token. Always present. */
  accessToken: string;
  /** OIDC ID token (a JWT), when the provider returns one. */
  idToken?: string;
  /** Refresh token, when the provider issues one (e.g. with `offline_access`). */
  refreshToken?: string;
  /** Absolute access-token expiry, epoch seconds, when known. */
  expiresAt?: number;
}

/**
 * Whether the session's access token has expired. An unknown expiry counts as
 * unexpired — the token is passed through and the provider is the arbiter.
 */
export function isSessionExpired(
  session: SessionData,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return session.expiresAt !== undefined && session.expiresAt <= nowSeconds;
}

// The AES-GCM key is derived from the password once (PBKDF2 is deliberately
// expensive) and reused for every seal/unseal. A fixed application salt keeps
// the key cacheable; per-seal security comes from the random IV. The password
// itself is expected to be a high-entropy 32+ char secret.
let keyPromise: Promise<CryptoKey> | undefined;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    let matchedName: string | undefined;
    let password: string | undefined;
    for (const name of COOKIE_PASSWORD_ENV_VARS) {
      const value = process.env[name];
      if (value) {
        matchedName = name;
        password = value;
        break;
      }
    }
    if (!password) {
      throw new Error(
        `[auth-tanstack] Missing required environment variable: ${COOKIE_PASSWORD_ENV_VARS.join(" or ")}`,
      );
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `[auth-tanstack] ${matchedName} must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    keyPromise = crypto.subtle
      .importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: KEY_SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      )
      .catch((error) => {
        // Don't cache a failed derivation (e.g. transient crypto error).
        keyPromise = undefined;
        throw error;
      });
  }
  return keyPromise;
}

/** Seal a session into a versioned, cookie-safe `v1.<iv>.<ciphertext>` string. */
export async function sealSession(data: SessionData): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(data));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/** Reverse {@link sealSession}. Returns null for any malformed/tampered value. */
export async function unsealSession(value: string): Promise<SessionData | null> {
  const parts = value.split(".");
  const [version, ivPart, ctPart] = parts;
  if (parts.length !== 3 || version !== "v1" || !ivPart || !ctPart) return null;
  try {
    const key = await getKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart) },
      key,
      fromBase64Url(ctPart),
    );
    const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as SessionData).accessToken === "string"
    ) {
      return parsed as SessionData;
    }
    return null;
  } catch {
    return null;
  }
}

/** Cookie name for the Nth session chunk. */
export function sessionChunkName(index: number): string {
  return `${sessionCookieBase()}.${index}`;
}

/** Split a sealed value into cookie-sized chunk values. */
export function chunkValue(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += MAX_CHUNK_LENGTH) {
    chunks.push(value.slice(i, i + MAX_CHUNK_LENGTH));
  }
  return chunks;
}

function isWrittenChunk(name: string, writtenCount: number): boolean {
  const base = sessionCookieBase();
  if (!name.startsWith(`${base}.`)) return false;
  const index = Number(name.slice(base.length + 1));
  return Number.isInteger(index) && index >= 0 && index < writtenCount;
}

/**
 * From a set of existing cookie names, the session cookies that should be
 * expired after writing `writtenCount` fresh chunks: any chunk beyond the new
 * count, plus a legacy single cookie. Used to avoid stale chunks lingering.
 */
export function staleSessionCookieNames(
  existingNames: readonly string[],
  writtenCount: number,
): string[] {
  const base = sessionCookieBase();
  return existingNames.filter((name) => {
    const isSessionCookie = name === base || name.startsWith(`${base}.`);
    return isSessionCookie && !isWrittenChunk(name, writtenCount);
  });
}

/**
 * `Set-Cookie` strings expiring every cookie in `names`. When a `domain` is
 * configured, each name is deleted twice — domain-scoped and host-only —
 * because browsers match deletions on name/path/domain, and a host-only
 * session cookie set before the domain was configured would otherwise
 * survive and keep the user signed in.
 */
function expireCookieHeaders(
  names: readonly string[],
  options: Pick<CookieOptions, "secure" | "sameSite" | "domain" | "path">,
): string[] {
  const hostOnly: CookieOptions = {
    path: options.path ?? "/",
    maxAge: 0,
    ...(options.sameSite ? { sameSite: options.sameSite } : {}),
    ...(options.secure ? { secure: options.secure } : {}),
  };
  return names.flatMap((name) =>
    options.domain
      ? [
          serializeCookie(name, "", { ...hostOnly, domain: options.domain }),
          serializeCookie(name, "", hostOnly),
        ]
      : [serializeCookie(name, "", hostOnly)],
  );
}

/**
 * Serialize a sealed session value into one or more `Set-Cookie` header strings,
 * splitting it across numbered chunks. Any `existingNames` that belonged to a
 * prior (longer) session — or a legacy single cookie — are expired so stale
 * chunks don't linger.
 */
export function serializeSessionCookies(
  value: string,
  options: CookieOptions,
  existingNames: readonly string[] = [],
): string[] {
  const chunks = chunkValue(value);
  const headers = chunks.map((chunk, index) =>
    serializeCookie(sessionChunkName(index), chunk, options),
  );

  // Expire stale chunks with the same SameSite/Secure as the fresh write so the
  // deletion is accepted in the same (possibly cross-site) context.
  const stale = staleSessionCookieNames(existingNames, chunks.length);
  headers.push(...expireCookieHeaders(stale, options));
  return headers;
}

/**
 * Reassemble a sealed session value from parsed cookies, concatenating
 * `${SESSION_COOKIE}.0`, `.1`, … (or reading a legacy single cookie).
 */
export function deserializeSessionCookies(cookies: Record<string, string>): string | null {
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    const part = cookies[sessionChunkName(i)];
    if (part === undefined) break;
    parts.push(part);
  }
  if (parts.length > 0) return parts.join("");
  return cookies[sessionCookieBase()] ?? null;
}

/**
 * Build `Set-Cookie` strings that expire every session cookie (all chunks).
 *
 * Pass the `secure`/`sameSite` the session was set with so the deletion is
 * honored in the same context — a `SameSite=None; Secure` cookie set for an
 * embedded (cross-site) app is only cleared by a matching delete cookie. When
 * a `domain` is configured, each cookie is deleted both domain-scoped and
 * host-only (see {@link expireCookieHeaders}).
 */
export function clearSessionCookies(
  existingNames: readonly string[],
  options: Pick<CookieOptions, "secure" | "sameSite" | "domain"> = {},
): string[] {
  const base = sessionCookieBase();
  return expireCookieHeaders(
    existingNames.filter((name) => name === base || name.startsWith(`${base}.`)),
    options,
  );
}
