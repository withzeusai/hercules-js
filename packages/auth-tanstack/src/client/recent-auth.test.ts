import { describe, it, expect } from "vitest";
import { evaluateRecentAuth } from "./recent-auth";

describe("evaluateRecentAuth", () => {
  const now = 1_000_000;

  it("reports recent auth as not stale", () => {
    const result = evaluateRecentAuth({ authTime: now - 100, maxAgeSeconds: 300, nowSeconds: now });
    expect(result.isStale).toBe(false);
    expect(result.authenticatedAt).toEqual(new Date((now - 100) * 1000));
  });

  it("reports auth older than maxAge as stale", () => {
    const result = evaluateRecentAuth({ authTime: now - 400, maxAgeSeconds: 300, nowSeconds: now });
    expect(result.isStale).toBe(true);
  });

  it("fails closed when auth_time is missing or non-numeric", () => {
    expect(evaluateRecentAuth({ authTime: undefined, maxAgeSeconds: 300, nowSeconds: now })).toEqual({
      authenticatedAt: null,
      isStale: true,
    });
    expect(evaluateRecentAuth({ authTime: "nope", maxAgeSeconds: 300, nowSeconds: now }).isStale).toBe(true);
  });
});
