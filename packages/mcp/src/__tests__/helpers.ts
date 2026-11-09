/** A stand-in Hercules Auth tenant: one RSA key, its discovery document and its JWKS. */
export const ISSUER = "https://demo.hercules-auth.test";
export const AUDIENCE = "https://happy-otter-123.convex.site/mcp";

function base64Url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TestIssuer {
  fetch: typeof fetch;
  /** How many times the JWKS was fetched. */
  jwksFetches: () => number;
  sign: (
    claims: Record<string, unknown>,
    options?: { kid?: string; alg?: string; key?: CryptoKey },
  ) => Promise<string>;
  setReachable: (reachable: boolean) => void;
}

export async function generateKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

export async function createTestIssuer(kid = "key-1"): Promise<TestIssuer> {
  const pair = await generateKey();
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let fetches = 0;
  let reachable = true;

  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!reachable) throw new Error("unreachable");
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) {
      fetches++;
      return Response.json({ keys: [{ ...publicJwk, kid }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    jwksFetches: () => fetches,
    setReachable(value) {
      reachable = value;
    },
    async sign(claims, options = {}) {
      const header = base64Url(
        JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? kid, typ: "JWT" }),
      );
      const payload = base64Url(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        options.key ?? pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${base64Url(signature)}`;
    },
  };
}

export const NOW_MS = Date.UTC(2026, 10, 9, 12, 0, 0);
export const NOW_SECONDS = NOW_MS / 1000;

/** Claims for a signed-in end user, valid for ten minutes around `NOW_MS`. */
export function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user_123",
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 600,
    ...overrides,
  };
}

export function rpcRequest(
  token: string | null,
  body: unknown,
  init: { method?: string; url?: string } = {},
): Request {
  const method = init.method ?? "POST";
  return new Request(init.url ?? AUDIENCE, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    ...(method === "POST" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
