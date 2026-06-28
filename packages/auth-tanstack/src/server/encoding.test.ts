import { describe, it, expect } from "vitest";
import { fromBase64Url, toBase64Url } from "./encoding";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it("produces cookie-safe output (no +, /, =, or whitespace)", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=\s]/);
  });

  it("round-trips a UTF-8 string", () => {
    const text = "héllo · wörld · 🔐";
    const encoded = toBase64Url(new TextEncoder().encode(text));
    expect(new TextDecoder().decode(fromBase64Url(encoded))).toBe(text);
  });

  it("decodes regardless of stripped padding", () => {
    // Inputs whose byte length is 1 and 2 mod 3 would normally carry padding.
    expect(Array.from(fromBase64Url(toBase64Url(new Uint8Array([1]))))).toEqual([1]);
    expect(Array.from(fromBase64Url(toBase64Url(new Uint8Array([1, 2]))))).toEqual([1, 2]);
  });
});
