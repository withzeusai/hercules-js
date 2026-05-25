import { describe, expect, test, vi } from "vitest";
import { createAccessAdminActions } from "./access-admin";

describe("createAccessAdminActions", () => {
  test("uses generated SDK methods when available", async () => {
    const assign = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      authenticatedAction: identityBuilder,
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
      authenticatedAction: identityBuilder,
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
      authenticatedAction: identityBuilder,
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

  test("wraps scope lifecycle writes", async () => {
    const create = vi.fn().mockResolvedValue({ created: true });
    const archive = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      authenticatedAction: identityBuilder,
      client: {
        post: vi.fn(),
        accessControl: {
          scopes: { create, archive },
        },
      },
    });

    await getHandler(actions.createScope)(
      {},
      { name: "Acme", defaultRoleKey: "member", accountEntryMode: "allowlisted_only" },
    );
    await getHandler(actions.archiveScope)({}, { scopeId: "scope_1" });

    expect(create).toHaveBeenCalledWith({
      name: "Acme",
      default_role_key: "member",
      account_entry_mode: "allowlisted_only",
    });
    expect(archive).toHaveBeenCalledWith({ scope_id: "scope_1" });
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}

function getHandler(value: unknown) {
  return (value as { handler: (ctx: unknown, args: Record<string, unknown>) => unknown }).handler;
}
