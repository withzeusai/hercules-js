import { describe, expect, test, vi } from "vitest";
import {
  acceptAccessInvitation,
  createAccessAdminActions,
  createAccessInvitation,
  createAccessScope,
  createAccessScopeAction,
  createAccessUserActions,
  createResourceInvitation,
} from "./access-admin";

describe("createAccessAdminActions", () => {
  test("posts role assignment writes", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

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
        actor_mode: "service",
      },
    });
  });

  test("posts user exception writes", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await expect(
      getHandler(actions.setUserExceptions)(
        {},
        { scopeId: "scope_1", herculesAuthUserId: "user_1", allow: ["reports.export"], deny: [] },
      ),
    ).resolves.toEqual({ changed: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/user-exceptions/set", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: "user_1",
        allow: ["reports.export"],
        deny: [],
        actor_mode: "service",
      },
    });
  });

  test("requires the Hercules API key by default", async () => {
    const previous = process.env["HERCULES_API_KEY"];
    delete process.env["HERCULES_API_KEY"];
    const actions = createAccessAdminActions({ internalAction: identityBuilder });

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
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await getHandler(actions.revokeResourceGrant)({}, { scopeId: "scope_1", grantId: "grant_1" });
    await getHandler(actions.setGrantExpiry)(
      {},
      { scopeId: "scope_1", grantId: "grant_1", expiresAt: null },
    );

    expect(post).toHaveBeenNthCalledWith(1, "/v1/access-control/resource-grants/revoke", {
      body: { scope_id: "scope_1", grant_id: "grant_1", actor_mode: "service" },
    });
    expect(post).toHaveBeenNthCalledWith(2, "/v1/access-control/expiries/set", {
      body: { scope_id: "scope_1", grant_id: "grant_1", expires_at: null, actor_mode: "service" },
    });
  });

  test("sets resource permission rules for a role", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

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
        actor_mode: "service",
      },
    });
  });

  test("wraps scope lifecycle writes", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await getHandler(actions.archiveScope)({}, { scopeId: "scope_1" });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/archive", {
      body: { scope_id: "scope_1" },
    });
  });

  test("sets the default role for future members of a scope", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await getHandler(actions.setDefaultRole)({}, { scopeId: "scope_1", roleKey: "viewer" });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/set-default-role", {
      body: { scope_id: "scope_1", role_id: undefined, role_key: "viewer", actor_mode: "service" },
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
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

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
        actor_mode: "service",
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
      body: { token: "token_1", id_token: "id-token" },
    });
  });

  test("revokes invitations from an access-admin action", async () => {
    const post = vi.fn().mockResolvedValue({ invitation_id: "invite_1", revoked: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await expect(
      getHandler(actions.revokeInvitation)({}, { scopeId: "scope_1", invitationId: "invite_1" }),
    ).resolves.toEqual({ invitation_id: "invite_1", revoked: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/revoke", {
      body: { scope_id: "scope_1", invitation_id: "invite_1", actor_mode: "service" },
    });
  });

  test("creates scopes through an explicit app policy and normalizes the result", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_1",
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
        owner_hercules_auth_user_id: "auth_user_1",
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
    ).rejects.toMatchObject({ data: { code: "ACCESS_DENIED", message: "Access denied" } });
    expect(post).not.toHaveBeenCalled();
  });

  test("exposes a composable scope creation helper for app-specific metadata actions", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_2",
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
      created: true,
      sourceVersion: 8,
      projectionIds: ["projection_2"],
    });

    expect(post).toHaveBeenCalledWith("/v1/access-control/scopes/create", {
      body: {
        name: "Beta",
        default_role_key: "member",
        account_entry_mode: undefined,
        owner_hercules_auth_user_id: "auth_user_2",
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
        actor_mode: "service",
      },
    });
  });
});

// A stand-in for Convex's action/query/mutation builders: returns the function
// definition unchanged so getHandler can pull `.handler` straight back out. Typed
// as `any` so it satisfies the precise ActionBuilder<DataModel, Visibility>
// parameter types the factories expect (internal and public alike) without
// reconstructing the full builder type surface in the test.
const identityBuilder = ((definition: unknown) => definition) as never;

function getHandler(value: unknown) {
  return (value as { handler: (ctx: unknown, args: Record<string, unknown>) => unknown }).handler;
}

describe("actor_mode on resource-grant writes", () => {
  test("createResourceGrant defaults to service mode without an id_token", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await getHandler(actions.createResourceGrant)(
      {},
      {
        scopeId: "scope_1",
        herculesAuthUserId: "auth_user_2",
        resourceType: "app.project",
        resourceId: "project_1",
        roleKey: "project_contributor",
      },
    );

    expect(post).toHaveBeenCalledWith("/v1/access-control/resource-grants/create", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: "auth_user_2",
        resource_type: "app.project",
        resource_id: "project_1",
        role_key: "project_contributor",
        permission_key: undefined,
        expires_at: undefined,
        actor_mode: "service",
      },
    });
    const [, sent] = post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(sent.body).not.toHaveProperty("id_token");
  });

  test("createResourceGrant supports all resources of a type", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await getHandler(actions.createResourceGrant)(
      {},
      {
        scopeId: "scope_1",
        herculesAuthUserId: "user_1",
        resourceType: "app.projects",
        resourceId: null,
        permissionKey: "app.projects:read",
      },
    );

    expect(post).toHaveBeenCalledWith("/v1/access-control/resource-grants/create", {
      body: expect.objectContaining({ resource_type: "app.projects", resource_id: null }),
    });
  });

  test("createResourceGrant delegates as app_user when an id_token is passed", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.createResourceGrant)(
      {},
      {
        scopeId: "scope_1",
        herculesAuthUserId: "auth_user_2",
        resourceType: "app.project",
        resourceId: "project_1",
        roleKey: "project_contributor",
        idToken: "id-token",
      },
    );

    expect(post).toHaveBeenCalledWith("/v1/access-control/resource-grants/create", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: "auth_user_2",
        resource_type: "app.project",
        resource_id: "project_1",
        role_key: "project_contributor",
        permission_key: undefined,
        expires_at: undefined,
        actor_mode: "app_user",
        id_token: "id-token",
      },
    });
  });

  test("revokeResourceGrant and setGrantExpiry forward the app_user id_token when delegated", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.revokeResourceGrant)(
      {},
      { scopeId: "scope_1", grantId: "grant_1", idToken: "id-token" },
    );
    await getHandler(actions.setGrantExpiry)(
      {},
      { scopeId: "scope_1", grantId: "grant_1", expiresAt: null, idToken: "id-token" },
    );

    expect(post).toHaveBeenNthCalledWith(1, "/v1/access-control/resource-grants/revoke", {
      body: {
        scope_id: "scope_1",
        grant_id: "grant_1",
        actor_mode: "app_user",
        id_token: "id-token",
      },
    });
    expect(post).toHaveBeenNthCalledWith(2, "/v1/access-control/expiries/set", {
      body: {
        scope_id: "scope_1",
        grant_id: "grant_1",
        expires_at: null,
        actor_mode: "app_user",
        id_token: "id-token",
      },
    });
  });
});

describe("createAccessUserActions", () => {
  test("enters the current deployment and normalizes the decision", async () => {
    const post = vi.fn().mockResolvedValue({
      allowed: true,
      reason: "open_allowed",
      principal_id: "principal_1",
      status: "active",
      state_version: 7,
      changed: true,
    });
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.enterDeployment)({}, { idToken: "  id-token  " }),
    ).resolves.toEqual({
      allowed: true,
      reason: "open_allowed",
      principalId: "principal_1",
      status: "active",
      stateVersion: 7,
      changed: true,
    });
    expect(post).toHaveBeenCalledWith("/v1/access-control/entry", {
      body: { id_token: "id-token" },
    });
  });

  test("returns a denied deployment-entry decision", async () => {
    const post = vi.fn().mockResolvedValue({
      allowed: false,
      reason: "not_allowlisted",
      principal_id: "principal_1",
      status: "pending_approval",
      state_version: 11,
      changed: false,
    });
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await expect(getHandler(actions.enterDeployment)({}, { idToken: "id-token" })).resolves.toEqual(
      {
        allowed: false,
        reason: "not_allowlisted",
        principalId: "principal_1",
        status: "pending_approval",
        stateVersion: 11,
        changed: false,
      },
    );
  });

  test("rejects an empty deployment-entry ID token before calling the API", async () => {
    const post = vi.fn();
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await expect(getHandler(actions.enterDeployment)({}, { idToken: " " })).rejects.toThrow(
      "idToken is required",
    );
    expect(post).not.toHaveBeenCalled();
  });

  test("delegates scope administration with the verified app-user actor", async () => {
    const post = vi.fn().mockResolvedValue({
      access_scope_id: "scope_1",
      invitation_id: "invite_1",
      email: "member@example.com",
      role_ids: ["role_member"],
      token: "token_1",
      accept_url: "https://app.example.com/invite?token=token_1",
      expires_at: "2026-06-11T00:00:00.000Z",
      source_version: 1,
      projection_ids: [],
    });
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.assignRole)(
      {},
      { scopeId: "scope_1", herculesAuthUserId: "user_1", roleKey: "member", idToken: "id-token" },
    );
    await getHandler(actions.createInvitation)(
      {},
      {
        scopeId: "scope_1",
        email: "member@example.com",
        roleKeys: ["member"],
        idToken: "id-token",
      },
    );
    await getHandler(actions.createOrgCustomRole)(
      {},
      {
        scopeId: "scope_1",
        name: "Reviewer",
        permissionKeys: ["app.docs:read"],
        idToken: "id-token",
      },
    );
    await getHandler(actions.setRoleOverride)(
      {},
      {
        scopeId: "scope_1",
        roleKey: "member",
        allow: ["app.docs:read"],
        deny: [],
        idToken: "id-token",
      },
    );

    expect(post.mock.calls.map(([path]) => path)).toEqual([
      "/v1/access-control/roles/assign",
      "/v1/access-control/invitations/create",
      "/v1/access-control/roles/create-org-custom",
      "/v1/access-control/role-overrides/set",
    ]);
    for (const [, request] of post.mock.calls as Array<
      [string, { body: Record<string, unknown> }]
    >) {
      expect(request.body).toMatchObject({ actor_mode: "app_user", id_token: "id-token" });
    }
  });
});

describe("createResourceInvitation", () => {
  const writeResult = {
    access_scope_id: "scope_1",
    invitation_id: "invite_1",
    email: "pm@example.com",
    role_ids: ["role_contributor"],
    token: "token_1",
    accept_url: "https://app.example.com/invite?token=token_1",
    expires_at: "2026-06-11T00:00:00.000Z",
    source_version: 12,
    projection_ids: ["projection_1"],
  };
  const parsedResult = {
    accessScopeId: "scope_1",
    invitationId: "invite_1",
    email: "pm@example.com",
    roleIds: ["role_contributor"],
    token: "token_1",
    acceptUrl: "https://app.example.com/invite?token=token_1",
    expiresAt: "2026-06-11T00:00:00.000Z",
    sourceVersion: 12,
    projectionIds: ["projection_1"],
  };

  test("posts to invitations/create-resource as service and parses the write result", async () => {
    const post = vi.fn().mockResolvedValue(writeResult);

    await expect(
      createResourceInvitation(
        {
          scopeId: "scope_1",
          email: "pm@example.com",
          resourceType: "app.project",
          resourceId: "project_1",
          roleKey: "project_contributor",
          expiresInDays: 7,
        },
        { client: { post } },
      ),
    ).resolves.toEqual(parsedResult);

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/create-resource", {
      body: {
        scope_id: "scope_1",
        email: "pm@example.com",
        resource_type: "app.project",
        resource_id: "project_1",
        role_key: "project_contributor",
        permission_key: undefined,
        expires_in_days: 7,
        actor_mode: "service",
      },
    });
  });

  test("public app-user action requires an id_token and sends a single permission_key", async () => {
    const post = vi.fn().mockResolvedValue(writeResult);
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await getHandler(actions.createResourceInvitation)(
      {},
      {
        scopeId: "scope_1",
        email: "pm@example.com",
        resourceType: "app.project",
        resourceId: "project_1",
        permissionKey: "app.project:edit",
        idToken: "id-token",
      },
    );

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/create-resource", {
      body: {
        scope_id: "scope_1",
        email: "pm@example.com",
        resource_type: "app.project",
        resource_id: "project_1",
        role_key: undefined,
        permission_key: "app.project:edit",
        expires_in_days: undefined,
        actor_mode: "app_user",
        id_token: "id-token",
      },
    });
  });

  test("is exposed as an access-admin action", async () => {
    const post = vi.fn().mockResolvedValue(writeResult);
    const actions = createAccessAdminActions({ internalAction: identityBuilder, client: { post } });

    await expect(
      getHandler(actions.createResourceInvitation)(
        {},
        {
          scopeId: "scope_1",
          email: "pm@example.com",
          resourceType: "app.project",
          resourceId: "project_1",
          roleKey: "project_contributor",
        },
      ),
    ).resolves.toEqual(parsedResult);

    expect(post).toHaveBeenCalledWith("/v1/access-control/invitations/create-resource", {
      body: {
        scope_id: "scope_1",
        email: "pm@example.com",
        resource_type: "app.project",
        resource_id: "project_1",
        role_key: "project_contributor",
        permission_key: undefined,
        expires_in_days: undefined,
        actor_mode: "service",
      },
    });
  });

  test("rejects an empty app-user id token before calling the API", async () => {
    const post = vi.fn();
    const actions = createAccessUserActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.createResourceInvitation)(
        {},
        {
          scopeId: "scope_1",
          email: "pm@example.com",
          resourceType: "app.project",
          resourceId: "project_1",
          roleKey: "project_contributor",
          idToken: " ",
        },
      ),
    ).rejects.toThrow("idToken is required");
    expect(post).not.toHaveBeenCalled();
  });
});
