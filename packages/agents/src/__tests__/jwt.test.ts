import { describe, expect, it, vi } from "vitest";
import { bearerTokenOf, createTokenVerifier, deploymentOrigins } from "../jwt";
import {
  AUDIENCE,
  createTestIssuer,
  generateKey,
  ISSUER,
  NOW_MS,
  NOW_SECONDS,
  userClaims,
} from "./helpers";

async function setup(options: { now?: () => number } = {}) {
  const issuer = await createTestIssuer();
  const verifier = createTokenVerifier({
    issuer: ISSUER,
    audiences: [AUDIENCE],
    fetch: issuer.fetch,
    now: options.now ?? (() => NOW_MS),
  });
  return { issuer, verifier };
}

describe("createTokenVerifier", () => {
  it("accepts a token the issuer signed for this audience", async () => {
    const { issuer, verifier } = await setup();
    const result = await verifier.verify(await issuer.sign(userClaims()));
    expect(result).toMatchObject({ ok: true, token: { issuer: ISSUER, subject: "user_123" } });
  });

  it("accepts a token whose audience list includes this server", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims({ aud: ["https://other.example", AUDIENCE] }));
    expect((await verifier.verify(token)).ok).toBe(true);
  });

  it.each([
    ["no token", null, "missing"],
    ["text that is not a JWT", "not-a-jwt", "malformed"],
    ["segments that are not JSON", "abc.def.ghi", "malformed"],
  ])("refuses %s", async (_name, token, reason) => {
    const { verifier } = await setup();
    expect(await verifier.verify(token)).toEqual({ ok: false, reason });
  });

  it.each([
    ["another issuer", { iss: "https://evil.example" }, "wrong_issuer"],
    [
      "another server",
      { aud: "https://happy-otter-123.convex.site/mcp/billing" },
      "wrong_audience",
    ],
    ["no audience", { aud: undefined }, "wrong_audience"],
    ["an expiry in the past", { exp: NOW_SECONDS - 60 }, "expired"],
    ["no expiry", { exp: undefined }, "expired"],
    ["a start in the future", { nbf: NOW_SECONDS + 300 }, "not_yet_valid"],
    ["no subject", { sub: undefined }, "malformed"],
  ])("refuses a token with %s", async (_name, overrides, reason) => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims(overrides));
    expect(await verifier.verify(token)).toEqual({ ok: false, reason });
  });

  it("tolerates a small clock difference on expiry", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims({ exp: NOW_SECONDS - 10 }));
    expect((await verifier.verify(token)).ok).toBe(true);
  });

  it("refuses a token signed by a key the issuer does not publish", async () => {
    const { issuer, verifier } = await setup();
    const stranger = await generateKey();
    const token = await issuer.sign(userClaims(), { key: stranger.privateKey });
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a payload changed after signing", async () => {
    const { issuer, verifier } = await setup();
    const [header, , signature] = (await issuer.sign(userClaims())).split(".");
    const forged = btoa(JSON.stringify(userClaims({ sub: "user_admin" }))).replace(/=+$/, "");
    const result = await verifier.verify(`${header}.${forged}.${signature}`);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each(["none", "HS256"])("refuses the %s algorithm", async (alg) => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims(), { alg });
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "unsupported_algorithm" });
  });

  it("refuses an unknown kid without refetching on every token", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims(), { kid: "key-9" });
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "unknown_key" });
    expect(issuer.jwksFetches()).toBe(1);
  });

  it("fetches the keys once for many tokens", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.sign(userClaims());
    await Promise.all([verifier.verify(token), verifier.verify(token), verifier.verify(token)]);
    await verifier.verify(token);
    expect(issuer.jwksFetches()).toBe(1);
  });

  it("refetches the keys once they are stale", async () => {
    let nowMs = NOW_MS;
    const { issuer, verifier } = await setup({ now: () => nowMs });
    const token = await issuer.sign(userClaims({ exp: NOW_SECONDS + 3600 }));
    await verifier.verify(token);
    nowMs += 6 * 60 * 1000;
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(issuer.jwksFetches()).toBe(2);
  });

  it("keeps verifying with the keys it holds while the issuer is unreachable", async () => {
    let nowMs = NOW_MS;
    const { issuer, verifier } = await setup({ now: () => nowMs });
    const token = await issuer.sign(userClaims({ exp: NOW_SECONDS + 3600 }));
    await verifier.verify(token);
    issuer.setReachable(false);
    nowMs += 6 * 60 * 1000;
    expect((await verifier.verify(token)).ok).toBe(true);
  });

  it("reports unavailable keys when the issuer was never reachable", async () => {
    const { issuer, verifier } = await setup();
    issuer.setReachable(false);
    const token = await issuer.sign(userClaims());
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("says the keys are unavailable, not that the token is bad, after a failed fetch", async () => {
    let nowMs = NOW_MS;
    const { issuer, verifier } = await setup({ now: () => nowMs });
    const token = await issuer.sign(userClaims({ exp: NOW_SECONDS + 3600 }));
    issuer.setReachable(false);
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "keys_unavailable" });
    // A second token arrives before the keys may be fetched again. A caller
    // that reads a refusal as "this deployment refuses us" must not get one.
    nowMs += 1_000;
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(issuer.jwksFetches()).toBe(0);
    nowMs += 20_000;
    issuer.setReachable(true);
    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "keys_unavailable" });
    // Once the floor has passed the keys are fetched, and the token is good.
    nowMs += 10_000;
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(issuer.jwksFetches()).toBe(1);
  });

  it("gives up on an issuer that does not answer, in time to answer its own caller", async () => {
    vi.useFakeTimers();
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({ issuer: ISSUER, audiences: [AUDIENCE], fetch: hanging });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await issuer.sign(userClaims({ iat: nowSeconds, exp: nowSeconds + 600 }));
    const result = verifier.verify(token);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toEqual({ ok: false, reason: "keys_unavailable" });
    vi.useRealTimers();
  });

  it("ignores a discovery document that names another issuer", async () => {
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({
      issuer: ISSUER,
      audiences: [AUDIENCE],
      now: () => NOW_MS,
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/.well-known/openid-configuration")) {
          return Response.json({ issuer: "https://evil.example", jwks_uri: `${ISSUER}/jwks` });
        }
        return issuer.fetch(input);
      }) as typeof fetch,
    });
    const result = await verifier.verify(await issuer.sign(userClaims()));
    expect(result).toEqual({ ok: false, reason: "keys_unavailable" });
  });
});

describe("deploymentOrigins", () => {
  it("takes the site URL, and the .convex.site origin of the cloud URL", () => {
    expect(
      deploymentOrigins(
        "https://happy-otter-123.convex.site",
        "https://happy-otter-123.convex.cloud",
      ),
    ).toEqual(["https://happy-otter-123.convex.site"]);
    // A custom domain for HTTP actions: Hercules still signs for .convex.site.
    expect(
      deploymentOrigins("https://api.example.com/", "https://happy-otter-123.convex.cloud"),
    ).toEqual(["https://api.example.com", "https://happy-otter-123.convex.site"]);
    expect(deploymentOrigins(undefined, "https://happy-otter-123.eu-west-1.convex.cloud")).toEqual([
      "https://happy-otter-123.eu-west-1.convex.site",
    ]);
    // Both overridden: nothing can be derived.
    expect(deploymentOrigins("https://api.example.com", "https://convex.example.com")).toEqual([
      "https://api.example.com",
    ]);
    expect(deploymentOrigins(undefined, undefined)).toEqual([]);
    expect(deploymentOrigins(undefined, "http://happy-otter-123.convex.cloud")).toEqual([]);
  });
});

describe("bearerTokenOf", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Basic abc", null],
    ["Bearer", null],
  ])("reads %j as %j", (header, expected) => {
    const request = new Request(AUDIENCE, { headers: { authorization: header } });
    expect(bearerTokenOf(request)).toBe(expected);
  });

  it("reads a request with no header as null", () => {
    expect(bearerTokenOf(new Request(AUDIENCE))).toBeNull();
  });
});
