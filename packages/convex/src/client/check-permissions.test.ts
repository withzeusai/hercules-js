import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Access, createAccess } from "./index.js";

// checkPermissions treats the component query ref as an opaque value, so a
// stub component and a captured runQuery are enough.
const checkManyRef = { ref: "checks.checkMany" };
const access: Access<never> = createAccess({
  query: vi.fn() as never,
  mutation: vi.fn() as never,
  action: vi.fn() as never,
  component: { queries: {}, checks: { checkMany: checkManyRef } } as never,
});

function makeCtx(input: { tokenIdentifier?: string }) {
  return {
    auth: {
      getUserIdentity: async () =>
        input.tokenIdentifier
          ? ({ tokenIdentifier: input.tokenIdentifier, subject: "user_1" } as never)
          : null,
    } as never,
    runQuery: vi.fn(),
  };
}

const TOKEN = "https://acme.auth|user_1";

describe("access.checkPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] for an empty check list without a round trip", async () => {
    const ctx = makeCtx({ tokenIdentifier: TOKEN });
    await expect(access.checkPermissions(ctx, [])).resolves.toEqual([]);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("returns all-false for unauthenticated callers without a round trip", async () => {
    const ctx = makeCtx({});
    await expect(
      access.checkPermissions(ctx, [
        { permission: "app.project:edit" },
        { permission: "app.project:delete" },
      ]),
    ).resolves.toEqual([false, false]);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("maps checks to one checkMany call and aligns results by index", async () => {
    const ctx = makeCtx({ tokenIdentifier: TOKEN });
    ctx.runQuery.mockResolvedValue([
      { allowed: true, reasonCode: "allowed" },
      { allowed: false, reasonCode: "access_denied" },
      { allowed: true, reasonCode: "allowed" },
    ]);

    const result = await access.checkPermissions(ctx, [
      { permission: "app.project:edit", tenant: "tenant_1" },
      {
        permission: "app.project:delete",
        tenant: "tenant_1",
        resource: { type: "app.project", externalId: "p1" },
      },
      { permission: "app.comment:create" },
    ]);

    expect(result).toEqual([true, false, true]);
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
    expect(ctx.runQuery).toHaveBeenCalledWith(checkManyRef, {
      tokenIdentifier: TOKEN,
      checks: [
        { tenantId: "tenant_1", permission: "app.project:edit" },
        {
          tenantId: "tenant_1",
          permission: "app.project:delete",
          resource: { type: "app.project", externalId: "p1" },
        },
        { permission: "app.comment:create" },
      ],
    });
  });

  it("chunks past 100 checks and concatenates results in order", async () => {
    const ctx = makeCtx({ tokenIdentifier: TOKEN });
    ctx.runQuery.mockImplementation(async (_ref, args: { checks: { permission: string }[] }) =>
      args.checks.map((check) => ({
        allowed: check.permission.endsWith(":yes"),
        reasonCode: "x",
      })),
    );

    const checks = Array.from({ length: 250 }, (_, i) => ({
      permission: `perm_${i}:${i % 3 === 0 ? "yes" : "no"}`,
    }));
    const result = await access.checkPermissions(ctx, checks);

    expect(ctx.runQuery).toHaveBeenCalledTimes(3);
    const sizes = ctx.runQuery.mock.calls.map(
      (call) => (call[1] as { checks: unknown[] }).checks.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(result).toHaveLength(250);
    expect(result).toEqual(checks.map((_, i) => i % 3 === 0));
  });
});
