import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Access, createAccess } from "./index.js";

const evaluateAccess = vi.fn();
vi.mock("@usehercules/sdk", () => ({
  default: class HerculesMock {
    iam = { tenants: { evaluateAccess } };
  },
}));

// enter only touches ctx.auth + ctx.runQuery and treats the component query
// refs as opaque values, so stub builders and an empty component are enough.
const access: Access<never> = createAccess({
  query: vi.fn() as never,
  mutation: vi.fn() as never,
  action: vi.fn() as never,
  component: { queries: {} } as never,
});

function makeCtx(input: {
  tokenIdentifier?: string;
  mirror?: unknown;
}): Parameters<typeof access.enter>[0] & { runQuery: ReturnType<typeof vi.fn> } {
  return {
    auth: {
      getUserIdentity: async () =>
        input.tokenIdentifier
          ? ({ tokenIdentifier: input.tokenIdentifier, subject: "user_1" } as never)
          : null,
    } as never,
    runQuery: vi
      .fn()
      .mockResolvedValue(input.mirror ?? { kind: "fallback", reason: "membership_missing" }),
  };
}

describe("access.enter", () => {
  beforeEach(() => {
    evaluateAccess.mockReset();
  });

  it("rejects unauthenticated callers without touching the control plane", async () => {
    const ctx = makeCtx({});
    await expect(access.enter(ctx)).rejects.toThrow(ConvexError);
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(evaluateAccess).not.toHaveBeenCalled();
  });

  it("short-circuits on an active mirror membership", async () => {
    const ctx = makeCtx({
      tokenIdentifier: "https://acme.auth|user_1",
      mirror: { kind: "principal", membershipId: "mem_1", status: "active", stateVersion: 5 },
    });

    await expect(access.enter(ctx)).resolves.toEqual({
      allowed: true,
      status: "active",
      reason: null,
      membershipId: "mem_1",
      sourceVersion: null,
    });
    expect(evaluateAccess).not.toHaveBeenCalled();
  });

  it("asks the control plane for entry when the mirror has no membership", async () => {
    evaluateAccess.mockResolvedValue({
      tenant_id: "tenant_1",
      user_id: "user_1",
      allowed: true,
      status: "active",
      reason: null,
      membership_id: "mem_2",
      convex_source_data: { changed: true, version: 9, projection_ids: ["dep_1"] },
    });
    const ctx = makeCtx({ tokenIdentifier: "https://acme.auth|user_1" });

    await expect(access.enter(ctx)).resolves.toEqual({
      allowed: true,
      status: "active",
      reason: null,
      membershipId: "mem_2",
      sourceVersion: 9,
    });
    expect(evaluateAccess).toHaveBeenCalledWith("primary", {
      actor_token_identifier: "https://acme.auth|user_1",
    });
  });

  it("targets the requested tenant and surfaces a denial", async () => {
    evaluateAccess.mockResolvedValue({
      tenant_id: "tenant_42",
      user_id: "user_1",
      allowed: false,
      status: "denied",
      reason: "invite_only",
      membership_id: null,
      convex_source_data: { changed: false, version: 3, projection_ids: ["dep_1"] },
    });
    const ctx = makeCtx({ tokenIdentifier: "https://acme.auth|user_1" });

    await expect(access.enter(ctx, { tenant: "tenant_42" })).resolves.toEqual({
      allowed: false,
      status: "denied",
      reason: "invite_only",
      membershipId: null,
      sourceVersion: 3,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith(undefined, {
      tokenIdentifier: "https://acme.auth|user_1",
      tenantId: "tenant_42",
    });
    expect(evaluateAccess).toHaveBeenCalledWith("tenant_42", {
      actor_token_identifier: "https://acme.auth|user_1",
    });
  });
});
