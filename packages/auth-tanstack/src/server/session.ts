import { serializeCookie, type CookieOptions } from "./cookie-utils";
import { fromBase64Url, toBase64Url } from "./encoding";

/** Base name of the (chunked) sealed session cookie. */
export const SESSION_COOKIE = "hercules_session";
/** Password used to derive the session-sealing key. */
const COOKIE_PASSWORD_ENV = "HERCULES_AUTH_COOKIE_PASSWORD";
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

// The AES-GCM key is derived from the password once (PBKDF2 is deliberately
// expensive) and reused for every seal/unseal. A fixed application salt keeps
// the key cacheable; per-seal security comes from the random IV. The password
// itself is expected to be a high-entropy 32+ char secret.
let keyPromise: Promise<CryptoKey> | undefined;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const password = process.env[COOKIE_PASSWORD_ENV];
    if (!password) {
      throw new Error(`[auth-tanstack] Missing required environment variable: ${COOKIE_PASSWORD_ENV}`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `[auth-tanstack] ${COOKIE_PASSWORD_ENV} must be at least ${MIN_PASSWORD_LENGTH} characters`,
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
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
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
    if (parsed && typeof parsed === "object" && typeof (parsed as SessionData).accessToken === "string") {
      return parsed as SessionData;
    }
    return null;
  } catch {
    return null;
  }
}

/** Cookie name for the Nth session chunk. */
export function sessionChunkName(index: number): string {
  return `${SESSION_COOKIE}.${index}`;
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
  if (!name.startsWith(`${SESSION_COOKIE}.`)) return false;
  const index = Number(name.slice(SESSION_COOKIE.length + 1));
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
  return existingNames.filter((name) => {
    const isSessionCookie = name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}.`);
    return isSessionCookie && !isWrittenChunk(name, writtenCount);
  });
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
  const headers = chunks.map((chunk, index) => serializeCookie(sessionChunkName(index), chunk, options));

  const clearOptions: CookieOptions = { path: options.path ?? "/", maxAge: 0 };
  for (const name of staleSessionCookieNames(existingNames, chunks.length)) {
    headers.push(serializeCookie(name, "", clearOptions));
  }
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
  return cookies[SESSION_COOKIE] ?? null;
}

/** Build `Set-Cookie` strings that expire every session cookie (all chunks). */
export function clearSessionCookies(existingNames: readonly string[]): string[] {
  const clearOptions: CookieOptions = { path: "/", maxAge: 0 };
  return existingNames
    .filter((name) => name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}.`))
    .map((name) => serializeCookie(name, "", clearOptions));
}
