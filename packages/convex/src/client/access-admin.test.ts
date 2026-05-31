import { describe, expect, test, vi } from "vitest";
import {
  acceptAccessInvitation,
  createAccessAdminActions,
  createAccessInvitation,
  createAccessScope,
  createAccessScopeAction,
} from "./access-admin";

describe("createAccessAdminActions", () => {
  test("posts role assignment writes", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.assignRole)({}, { scopeId: "scope_1", roleKey: "admin" }),
    ).resolves.toEqual({ changed: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/roles/assign", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: undefined,
        role_id: undefined,
        role_key: "admin",
      },
    });
  });

  test("posts user exception writes", async () => {
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
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.revokeResourceGrant)({}, { scopeId: "scope_1", grantId: "grant_1" });
    await getHandler(actions.setGrantExpiry)(
      {},
      { scopeId: "scope_1", grantId: "grant_1", expiresAt: null },
    );

    expect(post).toHaveBeenNthCalledWith(1, "/v1/access-control/resource-grants/revoke", {
      body: { scope_id: "scope_1", grant_id: "grant_1" },
    });
    expect(post).toHaveBeenNthCalledWith(2, "/v1/access-control/expiries/set", {
      body: {
        scope_id: "scope_1",
        grant_id: "grant_1",
        expires_at: null,
      },
    });
  });

  test("sets resource permission rules for a role", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.setResourcePermissionRule)(
      {},
      {
        scopeId: "scope_1",
        subject: { type: "role", roleKey: "member" },
        resourceType: "reports",
        target: { mode: "specific", resourceId: "report_private" },
        permissionKey: "reports.read",
        effect: "deny",
        expiresAt: null,
      },
    );

    expect(post).toHaveBeenCalledWith("/v1/access-control/resource-rules/set", {
      body: {
        scope_id: "scope_1",
        subject: { type: "role", role_key: "member" },
        resource_type: "reports",
        target: { mode: "specific", resource_id: "report_private" },
        permission_key: "reports.read",
        effect: "deny",
        expires_at: null,
      },
    });
  });

  test("wraps scope lifecycle writes", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.archiveScope)({}, { scopeId: "scope_1" });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/archive", {
      body: { scope_id: "scope_1" },
    });
  });

  test("sets the default role for future members of a scope", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.setDefaultRole)({}, { scopeId: "scope_1", roleKey: "viewer" });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/set-default-role", {
      body: {
        scope_id: "scope_1",
        role_id: undefined,
        role_key: "viewer",
      },
    });
  });

  test("creates invitations from an access-admin action and normalizes the result", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_1",
      invitation_id: "invite_1",
      email: "test@example.com",
      role_ids: ["role_admin"],
      token: "token_1",
      accept_url: "https://app.example.com/invite?token=token_1",
      expires_at: "2026-06-11T00:00:00.000Z",
      source_version: 9,
      projection_ids: [],
    });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.createInvitation)(
        {},
        { scopeId: "scope_1", email: "test@example.com", roleKeys: ["admin"] },
      ),
    ).resolves.toEqual({
      accessScopeId: "scope_1",
      invitationId: "invite_1",
      email: "test@example.com",
      roleIds: ["role_admin"],
      token: "token_1",
      acceptUrl: "https://app.example.com/invite?token=token_1",
      expiresAt: "2026-06-11T00:00:00.000Z",
      sourceVersion: 9,
      projectionIds: [],
    });

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/create", {
      body: {
        scope_id: "scope_1",
        email: "test@example.com",
        role_ids: undefined,
        role_keys: ["admin"],
        expires_in_days: undefined,
      },
    });
  });

  test("accepts invitations for the signed-in Hercules auth user", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_1",
      invitation_id: "invite_1",
      principal_id: "principal_1",
      role_ids: ["role_member"],
      changed: true,
      source_version: 10,
      projection_ids: ["projection_1"],
    });
    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|auth_user_1" }),
      },
    };

    await expect(
      acceptAccessInvitation(ctx, { token: "token_1", idToken: "id-token" }, { client: { post } }),
    ).resolves.toEqual({
      accessScopeId: "scope_1",
      invitationId: "invite_1",
      principalId: "principal_1",
      roleIds: ["role_member"],
      changed: true,
      sourceVersion: 10,
      projectionIds: ["projection_1"],
    });

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/accept", {
      body: {
        token: "token_1",
        id_token: "id-token",
      },
    });
  });

  test("revokes invitations from an access-admin action", async () => {
    const post = vi.fn().mockResolvedValue({ invitation_id: "invite_1", revoked: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.revokeInvitation)(
        {},
        { scopeId: "scope_1", invitationId: "invite_1" },
      ),
    ).resolves.toEqual({ invitation_id: "invite_1", revoked: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/revoke", {
      body: { scope_id: "scope_1", invitation_id: "invite_1" },
    });
  });

  test("creates scopes through an explicit app policy and normalizes the result", async () => {
    const post = vi.fn().mockResolvedValue({
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
      client: { post },
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
    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/create", {
      body: {
        name: "Acme",
        default_role_key: "member",
        account_entry_mode: "allowlisted_only",
        actor_hercules_auth_user_id: "auth_user_1",
      },
    });
  });

  test("does not call the API when scope creation policy denies", async () => {
    const post = vi.fn();
    const action = createAccessScopeAction({
      authenticatedAction: identityBuilder,
      canCreateScope: vi.fn().mockResolvedValue(false),
      client: { post },
    });

    await expect(
      getHandler(action)(
        { auth: { getUserIdentity: vi.fn() } },
        { name: "Acme", accountEntryMode: "allowlisted_only" },
      ),
    ).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED", message: "Access denied" },
    });
    expect(post).not.toHaveBeenCalled();
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

  test("exposes a composable invitation creation helper", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_2",
      invitation_id: "invite_2",
      email: "admin@example.com",
      role_ids: ["role_admin"],
      token: "token_2",
      accept_url: "https://app.example.com/invite?token=token_2",
      expires_at: "2026-06-12T00:00:00.000Z",
      source_version: 11,
      projection_ids: ["projection_2"],
    });

    await expect(
      createAccessInvitation(
        { scopeId: "scope_2", email: "admin@example.com", roleIds: ["role_admin"] },
        { client: { post } },
      ),
    ).resolves.toEqual({
      accessScopeId: "scope_2",
      invitationId: "invite_2",
      email: "admin@example.com",
      roleIds: ["role_admin"],
      token: "token_2",
      acceptUrl: "https://app.example.com/invite?token=token_2",
      expiresAt: "2026-06-12T00:00:00.000Z",
      sourceVersion: 11,
      projectionIds: ["projection_2"],
    });

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/create", {
      body: {
        scope_id: "scope_2",
        email: "admin@example.com",
        role_ids: ["role_admin"],
        role_keys: undefined,
        expires_in_days: undefined,
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
