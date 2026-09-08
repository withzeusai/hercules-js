import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_TIMEOUT_RETRIES,
  RETRY_MAX_DELAY_MS,
  renewRetryDelayMs,
  resolveMaxTimeoutRetries,
} from "./renew-retry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveMaxTimeoutRetries", () => {
  // The bug: oidc-client-ts ships no default for this, so the previous
  // `maxRetries !== undefined` guard was dead code and the renew loop retried
  // a revoked token every 5s forever.
  it("defaults to a bounded count when unset", () => {
    expect(resolveMaxTimeoutRetries({})).toBe(DEFAULT_MAX_TIMEOUT_RETRIES);
    expect(DEFAULT_MAX_TIMEOUT_RETRIES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_TIMEOUT_RETRIES)).toBe(true);
  });

  it("honors an explicit override, including zero", () => {
    expect(resolveMaxTimeoutRetries({ maxSilentRenewTimeoutRetries: 7 })).toBe(7);
    expect(resolveMaxTimeoutRetries({ maxSilentRenewTimeoutRetries: 0 })).toBe(0);
  });
});

describe("renewRetryDelayMs", () => {
  it("grows exponentially across attempts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = renewRetryDelayMs(1);
    const second = renewRetryDelayMs(2);
    const third = renewRetryDelayMs(3);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("caps the delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(renewRetryDelayMs(50)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("jitters so tabs that lost the same blip do not retry in lockstep", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const low = renewRetryDelayMs(3);
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const high = renewRetryDelayMs(3);
    expect(high).toBeGreaterThan(low);
  });

  it("never returns a negative or NaN delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (const attempt of [0, 1, 2, 10]) {
      const delay = renewRetryDelayMs(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });
});
