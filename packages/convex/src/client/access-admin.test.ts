import { describe, expect, test, vi } from "vitest";
import {
  createAccessAdminActions,
  createAccessScope,
  createAccessScopeAction,
} from "./access-admin";

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

  test("requires the Hercules API key by default", async () => {
    const previous = process.env["HERCULES_API_KEY"];
    delete process.env["HERCULES_API_KEY"];
    const actions = createAccessAdminActions({ accessAction: identityBuilder });

    await expect(
      getHandler(actions.assignRole)(
        {},
        { scopeId: "scope_1", herculesAuthUserId: "user_1", roleKey: "admin" },
      ),
    ).rejects.toThrow("HERCULES_API_KEY is required");

    if (previous === undefined) {
      delete process.env["HERCULES_API_KEY"];
    } else {
      process.env["HERCULES_API_KEY"] = previous;
    }
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

  test("wraps scope lifecycle writes", async () => {
    const archive = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: {
        post: vi.fn(),
        accessControl: {
          scopes: { archive },
        },
      },
    });

    await getHandler(actions.archiveScope)({}, { scopeId: "scope_1" });

    expect(archive).toHaveBeenCalledWith({ scope_id: "scope_1" });
  });

  test("creates scopes through an explicit app policy and normalizes the result", async () => {
    const create = vi.fn().mockResolvedValue({
      access_scope_id: "scope_1",
      access_scope_app_id: "scope_app_1",
      created: true,
      source_version: 7,
      projection_ids: ["projection_1"],
    });
    const canCreateScope = vi.fn().mockResolvedValue(true);
    const action = createAccessScopeAction({
      authenticatedAction: identityBuilder,
      canCreateScope,
      client: {
        post: vi.fn(),
        accessControl: {
          scopes: { create },
        },
      },
    });

    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|auth_user_1" }),
      },
    };
    await expect(
      getHandler(action)(ctx, {
        name: "Acme",
        defaultRoleKey: "member",
        accountEntryMode: "allowlisted_only",
      }),
    ).resolves.toEqual({
      accessScopeId: "scope_1",
      accessScopeAppId: "scope_app_1",
      created: true,
      sourceVersion: 7,
      projectionIds: ["projection_1"],
    });

    expect(canCreateScope).toHaveBeenCalledWith(ctx, {
      name: "Acme",
      defaultRoleKey: "member",
      accountEntryMode: "allowlisted_only",
    });
    expect(create).toHaveBeenCalledWith({
      name: "Acme",
      default_role_key: "member",
      account_entry_mode: "allowlisted_only",
      actor_hercules_auth_user_id: "auth_user_1",
    });
  });

  test("does not call the API when scope creation policy denies", async () => {
    const create = vi.fn();
    const action = createAccessScopeAction({
      authenticatedAction: identityBuilder,
      canCreateScope: vi.fn().mockResolvedValue(false),
      client: {
        post: vi.fn(),
        accessControl: {
          scopes: { create },
        },
      },
    });

    await expect(
      getHandler(action)(
        { auth: { getUserIdentity: vi.fn() } },
        { name: "Acme", accountEntryMode: "allowlisted_only" },
      ),
    ).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED", message: "Access denied" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("exposes a composable scope creation helper for app-specific metadata actions", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_2",
      access_scope_app_id: "scope_app_2",
      created: true,
      source_version: 8,
      projection_ids: ["projection_2"],
    });
    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|auth_user_2" }),
      },
    };

    await expect(
      createAccessScope(ctx, { name: "Beta", defaultRoleKey: "member" }, { client: { post } }),
    ).resolves.toEqual({
      accessScopeId: "scope_2",
      accessScopeAppId: "scope_app_2",
      created: true,
      sourceVersion: 8,
      projectionIds: ["projection_2"],
    });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/create", {
      body: {
        name: "Beta",
        default_role_key: "member",
        account_entry_mode: undefined,
        actor_hercules_auth_user_id: "auth_user_2",
      },
    });
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}

function getHandler(value: unknown) {
  return (value as { handler: (ctx: unknown, args: Record<string, unknown>) => unknown }).handler;
}
