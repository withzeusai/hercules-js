import { describe, expect, it, vi } from "vitest";
import { clearSessionIfInvalidGrant, isInvalidGrantError } from "./dead-session";

/** Shaped like an oidc-client-ts ErrorResponse for the fields we read. */
function oauthError(error: string, description?: string): Error & { error: string } {
  return Object.assign(new Error(description ?? error), { error });
}

describe("isInvalidGrantError", () => {
  it("recognizes invalid_grant", () => {
    // The message the provider returns once the token family is gone -- this
    // is the string end users see as "session not found".
    expect(isInvalidGrantError(oauthError("invalid_grant", "session not found"))).toBe(true);
    expect(isInvalidGrantError(oauthError("invalid_grant", "invalid refresh token"))).toBe(true);
  });

  it("ignores other OAuth errors and non-errors", () => {
    // Only invalid_grant means the stored token is permanently dead. A network
    // blip or a server fault must not throw away a still-valid session.
    expect(isInvalidGrantError(oauthError("invalid_client"))).toBe(false);
    expect(isInvalidGrantError(oauthError("temporarily_unavailable"))).toBe(false);
    expect(isInvalidGrantError(new Error("network failure"))).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
    expect(isInvalidGrantError(undefined)).toBe(false);
    expect(isInvalidGrantError("invalid_grant")).toBe(false);
  });
});

describe("clearSessionIfInvalidGrant", () => {
  it("removes the stored user on invalid_grant", async () => {
    const removeUser = vi.fn().mockResolvedValue(undefined);

    await expect(
      clearSessionIfInvalidGrant({ removeUser }, oauthError("invalid_grant", "session not found")),
    ).resolves.toBe(true);
    expect(removeUser).toHaveBeenCalledOnce();
  });

  it("leaves the session intact for a transient failure", async () => {
    const removeUser = vi.fn().mockResolvedValue(undefined);

    await expect(
      clearSessionIfInvalidGrant({ removeUser }, new Error("Failed to fetch")),
    ).resolves.toBe(false);
    expect(removeUser).not.toHaveBeenCalled();
  });

  it("never throws when removeUser rejects", async () => {
    // Runs inside failure handlers; a secondary throw would mask the original.
    const removeUser = vi.fn().mockRejectedValue(new Error("storage unavailable"));

    await expect(
      clearSessionIfInvalidGrant({ removeUser }, oauthError("invalid_grant")),
    ).resolves.toBe(false);
  });
});
