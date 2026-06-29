import { describe, it, expect } from "vitest";
import { decodeJwt } from "./jwt";

function makeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

describe("decodeJwt", () => {
  it("decodes the payload", () => {
    const token = makeJwt({ sub: "u1", org_id: "org_1", exp: 123 });
    expect(decodeJwt(token).payload).toEqual({ sub: "u1", org_id: "org_1", exp: 123 });
  });

  it("decodes UTF-8 claim values", () => {
    const token = makeJwt({ sub: "u1", name: "Renée Müller" });
    expect(decodeJwt<{ name: string }>(token).payload.name).toBe("Renée Müller");
  });

  it("throws on a token without three segments", () => {
    expect(() => decodeJwt("a.b")).toThrow("Invalid JWT format");
  });

  it("throws on a non-JSON payload", () => {
    expect(() => decodeJwt("aGVhZGVy.bm90LWpzb24.sig")).toThrow(/Failed to decode JWT/);
  });
});
