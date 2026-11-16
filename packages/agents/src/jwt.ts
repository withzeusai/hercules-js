/**
 * Verifies the bearer token on an MCP request: an RS256 JWT signed by the
 * app's Hercules Auth tenant. Web Crypto only, so it runs in a Convex HTTP
 * action, a Worker, and Node alike.
 */

export interface TokenVerifierOptions {
  /** The app's Hercules Auth URL, exactly as the token's `iss` reads. */
  issuer: string;
  /** The audiences this server answers to. A token must name at least one. */
  audiences: readonly string[];
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export interface VerifiedToken {
  issuer: string;
  subject: string;
  claims: Record<string, unknown>;
}

export type TokenFailure =
  | "missing"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "keys_unavailable";

export type TokenResult = { ok: true; token: VerifiedToken } | { ok: false; reason: TokenFailure };

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  [member: string]: unknown;
}

/** How long a fetched key set is trusted before it is fetched again. */
const KEY_SET_TTL_MS = 5 * 60 * 1000;
/** The least time between two fetches, so unknown `kid`s cannot make us hammer the issuer. */
const KEY_SET_MIN_REFETCH_MS = 30 * 1000;
/** Clock difference tolerated between the issuer and this server. */
const CLOCK_SKEW_SECONDS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function audiencesOf(claim: unknown): string[] {
  if (typeof claim === "string") return [claim];
  if (Array.isArray(claim)) return claim.filter((entry) => typeof entry === "string");
  return [];
}

/** The bearer token of a request, or null when it carries none. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * A verifier for one issuer. It keeps the issuer's published keys in memory
 * for a few minutes; build it once per server, not once per request.
 */
export function createTokenVerifier(options: TokenVerifierOptions) {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const issuer = options.issuer;

  let keySet: { keys: Jwk[]; loadedAtMs: number } | null = null;
  let lastFetchAtMs = Number.NEGATIVE_INFINITY;
  let loading: Promise<Jwk[] | null> | null = null;

  async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchFn(url, { headers: { accept: "application/json" } });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return isRecord(body) ? body : null;
    } catch {
      return null;
    }
  }

  async function fetchKeys(): Promise<Jwk[] | null> {
    const base = issuer.replace(/\/+$/, "");
    const discovery = await fetchJson(`${base}/.well-known/openid-configuration`);
    // A discovery document for another issuer could point us at another issuer's keys.
    if (discovery === null || discovery["issuer"] !== issuer) return null;
    const jwksUri = discovery["jwks_uri"];
    if (typeof jwksUri !== "string") return null;
    const jwks = await fetchJson(jwksUri);
    const keys = jwks?.["keys"];
    if (!Array.isArray(keys)) return null;
    return keys.filter((key): key is Jwk => isRecord(key));
  }

  function loadKeys(): Promise<Jwk[] | null> {
    if (loading !== null) return loading;
    lastFetchAtMs = now();
    const attempt = fetchKeys()
      .then((keys) => {
        if (keys !== null) keySet = { keys, loadedAtMs: now() };
        return keys;
      })
      .finally(() => {
        loading = null;
      });
    loading = attempt;
    return attempt;
  }

  async function findKey(kid: string): Promise<Jwk | "unavailable" | null> {
    const fresh = keySet !== null && now() - keySet.loadedAtMs < KEY_SET_TTL_MS;
    const cached = keySet?.keys.find((key) => key.kid === kid);
    if (fresh && cached) return cached;
    // An unknown `kid` may be a key published after our last fetch, so look
    // again, but not more often than the refetch floor allows.
    if (now() - lastFetchAtMs < KEY_SET_MIN_REFETCH_MS && loading === null) {
      return cached ?? null;
    }
    const keys = await loadKeys();
    // Keys we already hold stay good while the issuer cannot be reached.
    if (keys === null) return cached ?? "unavailable";
    return keys.find((key) => key.kid === kid) ?? null;
  }

  async function verify(token: string | null): Promise<TokenResult> {
    if (token === null) return { ok: false, reason: "missing" };
    const segments = token.split(".");
    if (segments.length !== 3) return { ok: false, reason: "malformed" };
    const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

    const header = decodeJsonSegment(headerSegment);
    const claims = decodeJsonSegment(payloadSegment);
    const signature = decodeBase64Url(signatureSegment);
    if (header === null || claims === null || signature === null) {
      return { ok: false, reason: "malformed" };
    }
    // One fixed algorithm: a token never gets to pick how it is checked.
    if (header["alg"] !== "RS256") return { ok: false, reason: "unsupported_algorithm" };
    const kid = header["kid"];
    if (typeof kid !== "string" || kid.length === 0) return { ok: false, reason: "unknown_key" };

    // Cheap claim checks first, so a token for someone else costs no key fetch.
    if (claims["iss"] !== issuer) return { ok: false, reason: "wrong_issuer" };
    const audiences = audiencesOf(claims["aud"]);
    if (!audiences.some((audience) => options.audiences.includes(audience))) {
      return { ok: false, reason: "wrong_audience" };
    }

    const jwk = await findKey(kid);
    if (jwk === "unavailable") return { ok: false, reason: "keys_unavailable" };
    if (jwk === null || jwk.kty !== "RSA") return { ok: false, reason: "unknown_key" };

    let valid: boolean;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      );
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: "bad_signature" };

    const nowSeconds = Math.floor(now() / 1000);
    const exp = claims["exp"];
    // A token with no expiry would never stop working, so it is refused.
    if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
      return { ok: false, reason: "expired" };
    }
    const nbf = claims["nbf"];
    if (typeof nbf === "number" && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      return { ok: false, reason: "not_yet_valid" };
    }

    const subject = claims["sub"];
    if (typeof subject !== "string" || subject.length === 0) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, token: { issuer, subject, claims } };
  }

  return { verify };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;
