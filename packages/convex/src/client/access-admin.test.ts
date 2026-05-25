import { describe, expect, test, vi } from "vitest";
import { createAccessAdminActions } from "./access-admin";

describe("createAccessAdminActions", () => {
  test("uses generated SDK methods when available", async () => {
    const assign = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: {
        post: vi.fn(),
        accessControl: { roles: { assign } },
      },
    });

    await expect(
      getHandler(actions.assignRole)({}, { scopeId: "scope_1", roleKey: "admin" }),
    ).resolves.toEqual({ changed: true });

    expect(assign).toHaveBeenCalledWith({
      scope_id: "scope_1",
      principal_id: undefined,
      hercules_auth_user_id: undefined,
      role_id: undefined,
      role_key: "admin",
    });
  });

  test("falls back to low-level SDK post until generated methods exist", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.setUserExceptions)(
        {},
        {
          scopeId: "scope_1",
          herculesAuthUserId: "user_1",
          allow: ["reports.export"],
          deny: [],
        },
      ),
    ).resolves.toEqual({ changed: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/user-exceptions/set", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: "user_1",
        allow: ["reports.export"],
        deny: [],
      },
    });
  });

  test("sends scope_id for grant revoke and expiry writes", async () => {
    const revoke = vi.fn().mockResolvedValue({ changed: true });
    const setExpiry = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: {
        post: vi.fn(),
        accessControl: {
          resourceGrants: { revoke },
          expiries: { set: setExpiry },
        },
      },
    });

    await getHandler(actions.revokeResourceGrant)({}, { scopeId: "scope_1", grantId: "grant_1" });
    await getHandler(actions.setGrantExpiry)(
      {},
      { scopeId: "scope_1", grantId: "grant_1", expiresAt: null },
    );

    expect(revoke).toHaveBeenCalledWith({ scope_id: "scope_1", grant_id: "grant_1" });
    expect(setExpiry).toHaveBeenCalledWith({
      scope_id: "scope_1",
      grant_id: "grant_1",
      expires_at: null,
    });
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}

function getHandler(value: unknown) {
  return (value as { handler: (ctx: unknown, args: Record<string, unknown>) => unknown }).handler;
}
