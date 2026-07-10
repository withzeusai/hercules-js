import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Access, createAccess } from "./index.js";

const syncStatusRef = { ref: "queries.getTargetTenantSyncStatus" };
const access: Access<never> = createAccess({
  query: vi.fn() as never,
  mutation: vi.fn() as never,
  action: vi.fn() as never,
  component: { queries: { getTargetTenantSyncStatus: syncStatusRef } } as never,
});

function makeCtx(statuses: unknown[]) {
  const runQuery = vi.fn();
  for (const status of statuses) runQuery.mockResolvedValueOnce(status);
  return {
    auth: {
      getUserIdentity: async () =>
        ({ tokenIdentifier: "https://acme.auth|user_1", subject: "user_1" }) as never,
    } as never,
    runQuery,
  };
}

describe("access.waitForSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns immediately on an already-terminal status", async () => {
    const ready = {
      state: "ready",
      currentSourceVersion: 7,
      targetSourceVersion: 7,
      tenantId: "t1",
      membershipId: "m1",
    };
    const ctx = makeCtx([ready]);

    await expect(access.waitForSync(ctx, { sourceVersion: 7 })).resolves.toEqual(ready);
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
    expect(ctx.runQuery).toHaveBeenCalledWith(syncStatusRef, {
      tokenIdentifier: "https://acme.auth|user_1",
      sourceVersion: 7,
    });
  });

  it("polls through syncing states until the mirror catches up", async () => {
    const syncing = { state: "syncing", currentSourceVersion: 5, targetSourceVersion: 7 };
    const denied = {
      state: "denied",
      reasonCode: "membership_pending_approval",
      currentSourceVersion: 7,
      targetSourceVersion: 7,
    };
    const ctx = makeCtx([syncing, syncing, denied]);

    const result = await access.waitForSync(ctx, { sourceVersion: 7, tenant: "t1" });

    expect(result).toEqual(denied);
    expect(ctx.runQuery).toHaveBeenCalledTimes(3);
    expect(ctx.runQuery).toHaveBeenLastCalledWith(syncStatusRef, {
      tokenIdentifier: "https://acme.auth|user_1",
      tenantId: "t1",
      sourceVersion: 7,
    });
  });

  it("throws a temporary mirror_not_ready error on timeout", async () => {
    const syncing = { state: "syncing", targetSourceVersion: 9 };
    const ctx = makeCtx([syncing, syncing, syncing, syncing, syncing, syncing]);

    await expect(access.waitForSync(ctx, { sourceVersion: 9, timeoutMs: 250 })).rejects.toThrow(
      /mirror_not_ready/,
    );
  });
});
