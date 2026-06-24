import { describe, expect, test, vi } from "vitest";
import {
  acceptIamInvitation,
  createDeploymentEntryAction,
  createIamManagementActions,
  createIamTenant,
  createIamTenantAction,
} from "./iam-management";
import { createIamServiceActions } from "./iam-service";

const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl";
const identityBuilder = ((definition: unknown) => definition) as never;

const API_RESULT = {
  tenant_id: "tenant_1",
  user_id: "user_1",
  group_id: "group_1",
  role_id: "role_1",
  role_key: "member",
  rule_id: "rule_1",
  invitation_id: "invitation_1",
  changed: true,
  created: true,
  revoked: true,
  source_version: 4,
  state_version: 4,
  projection_ids: ["projection_1"],
  previous_status: "pending_approval",
  status: "active",
  permission_keys: ["tasks.read"],
  grant: {
    grant_id: "grant_1",
    type: "role",
    role_id: "role_1",
    expires_at: null,
    applies_to: "self",
  },
  grants: [
    {
      conferral_id: "conferral_1",
      grant_id: "grant_1",
      type: "role",
      role_id: "role_1",
      expires_at: "2026-07-01T00:00:00.000Z",
    },
  ],
  roles: [
    {
      role_id: "role_1",
      role_key: "member",
      role_name: "Member",
      role_kind: "system",
      shared: true,
    },
  ],
  invitations: [],
  email: "person@example.com",
  target: { type: "tenant" },
  token: "invitation_token",
  accept_url: "https://example.com/invitations/accept",
  expires_at: "2026-07-01T00:00:00.000Z",
  created_at: "2026-06-24T00:00:00.000Z",
  updated_at: "2026-06-24T00:00:00.000Z",
  resource_type: "projects",
  resource_id: "project_1",
  subjects: [
    {
      subject: { type: "user", user_id: "user_1" },
      grants: [
        {
          grant_id: "grant_1",
          type: "role",
          role_id: "role_1",
          applies_to: "self",
          expires_at: null,
        },
      ],
    },
  ],
  allowed: true,
  reason: "open_allowed",
};

function getHandler(value: unknown) {
  return (
    value as {
      handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }
  ).handler;
}

function makeClient(result: Record<string, unknown> = API_RESULT) {
  return {
    get: vi.fn().mockResolvedValue(result),
    post: vi.fn().mockResolvedValue(result),
    patch: vi.fn().mockResolvedValue(result),
    put: vi.fn().mockResolvedValue(result),
    delete: vi.fn().mockResolvedValue(result),
  };
}

describe("tenant IAM REST actions", () => {
  test("uses REST verbs, tenant paths, and app-user headers", async () => {
    const client = makeClient();
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await getHandler(actions.updateTenant)(
      {},
      {
        tenantId: "tenant/one",
        defaultRole: { key: "member" },
        entryMode: "approval_required",
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.createUser)(
      {},
      {
        tenantId: "tenant/one",
        userId: "user@example.com",
        grant: { role: { id: "role_1" } },
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.addGroupMember)(
      {},
      {
        tenantId: "tenant/one",
        groupId: "group/one",
        userId: "user@example.com",
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.updateGroup)(
      {},
      {
        tenantId: "tenant/one",
        groupId: "group/one",
        action: "suspend",
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.createRole)(
      {},
      {
        tenantId: "tenant/one",
        key: "reviewer",
        name: "Reviewer",
        permissionKeys: ["tasks.read"],
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.createAdmissionRule)(
      {},
      {
        tenantId: "tenant/one",
        effect: "allow",
        subject: { type: "domain", value: "example.com" },
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.createInvitation)(
      {},
      {
        tenantId: "tenant/one",
        email: "person@example.com",
        target: { type: "tenant" },
        grants: [{ role: { key: "member" } }],
        idToken: ID_TOKEN,
      },
    );
    await getHandler(actions.replaceResourceGrants)(
      {},
      {
        tenantId: "tenant/one",
        resourceType: "project/type",
        resourceId: "project/one",
        subjects: [
          {
            subject: { type: "user", userId: "user@example.com" },
            grants: [{ role: { key: "member" } }],
          },
        ],
        idToken: ID_TOKEN,
      },
    );
    await expect(
      getHandler(actions.updateGrant)(
        {},
        {
          tenantId: "tenant/one",
          grantId: "grant/one",
          expiresAt: "2026-07-01T00:00:00.000Z",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      grant: {
        grantId: "grant_1",
        type: "role",
        roleId: "role_1",
        expiresAt: null,
        appliesTo: "self",
      },
    });
    await expect(
      getHandler(actions.deleteGrant)(
        {},
        {
          tenantId: "tenant/one",
          grantId: "grant/one",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      grant: {
        grantId: "grant_1",
        type: "role",
      },
    });

    const headers = {
      "x-hercules-iam-actor": "user",
      "x-hercules-user-id-token": ID_TOKEN,
    };
    expect(client.patch).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone", {
      headers,
      body: {
        default_role: { key: "member" },
        entry_mode: "approval_required",
      },
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/grants/grant%2Fone", {
      headers,
      body: { expires_at: "2026-07-01T00:00:00.000Z" },
    });
    expect(client.delete).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/grants/grant%2Fone", {
      headers,
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/users", {
      headers,
      body: {
        user_id: "user@example.com",
        grant: { role: { id: "role_1" } },
      },
    });
    expect(client.put).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant%2Fone/groups/group%2Fone/members/user%40example.com",
      { headers },
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/groups/group%2Fone", {
      headers,
      body: { action: "suspend" },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/roles", {
      headers,
      body: {
        key: "reviewer",
        name: "Reviewer",
        permission_keys: ["tasks.read"],
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/admission-rules", {
      headers,
      body: {
        effect: "allow",
        subject: { type: "domain", value: "example.com" },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/tenant%2Fone/invitations", {
      headers,
      body: {
        email: "person@example.com",
        target: { type: "tenant" },
        grants: [{ role: { key: "member" } }],
      },
    });
    expect(client.put).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant%2Fone/resources/project%2Ftype/project%2Fone/grants",
      {
        headers,
        body: {
          subjects: [
            {
              subject: { type: "user", user_id: "user@example.com" },
              grants: [{ role: { key: "member" } }],
            },
          ],
        },
      },
    );
  });

  test("supports discriminated group updates and permission overrides", async () => {
    const client = makeClient({
      ...API_RESULT,
      previous_status: "suspended",
      status: "active",
      grants: [
        {
          grant_id: "permission_grant_1",
          type: "permission",
          permission_id: "permission_1",
          permission_key: "documents.read",
          effect: "allow",
          expires_at: null,
        },
      ],
    });
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await getHandler(actions.updateGroup)(
      {},
      {
        tenantId: "tenant_1",
        groupId: "group_1",
        action: "rename",
        name: "Reviewers",
        idToken: ID_TOKEN,
      },
    );
    await expect(
      getHandler(actions.updateGroup)(
        {},
        {
          tenantId: "tenant_1",
          groupId: "group_1",
          action: "activate",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      groupId: "group_1",
      previousStatus: "suspended",
      status: "active",
    });
    await expect(
      getHandler(actions.listGroupPermissionOverrides)(
        {},
        {
          tenantId: "tenant_1",
          groupId: "group_1",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      tenantId: "tenant_1",
      groupId: "group_1",
      grants: [{ grantId: "permission_grant_1", type: "permission" }],
    });
    await getHandler(actions.replaceGroupPermissionOverrides)(
      {},
      {
        tenantId: "tenant_1",
        groupId: "group_1",
        overrides: [
          {
            permissionKey: "documents.read",
            effect: "allow",
            expiresAt: null,
          },
        ],
        idToken: ID_TOKEN,
      },
    );

    const headers = {
      "x-hercules-iam-actor": "user",
      "x-hercules-user-id-token": ID_TOKEN,
    };
    expect(client.patch).toHaveBeenCalledWith("/v1/iam/tenants/tenant_1/groups/group_1", {
      headers,
      body: { action: "rename", name: "Reviewers" },
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/iam/tenants/tenant_1/groups/group_1", {
      headers,
      body: { action: "activate" },
    });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant_1/groups/group_1/permission-overrides",
      { headers },
    );
    expect(client.put).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant_1/groups/group_1/permission-overrides",
      {
        headers,
        body: {
          overrides: [
            {
              permission_key: "documents.read",
              effect: "allow",
              expires_at: null,
            },
          ],
        },
      },
    );
  });

  test("lists paginated admission rules, audit events, and invitations", async () => {
    const admissionClient = makeClient({
      tenant_id: "tenant_1",
      admission_rules: [
        {
          rule_id: "rule_1",
          effect: "allow",
          subject: { type: "domain", value: "example.com" },
          reason: "Employees",
          archived: false,
          archived_at: null,
        },
      ],
      next_cursor: "rule_cursor_2",
    });
    const admissionActions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: admissionClient,
    });
    await expect(
      getHandler(admissionActions.listAdmissionRules)(
        {},
        {
          tenantId: "tenant_1",
          cursor: "rule_cursor_1",
          limit: 25,
          effect: "allow",
          subjectType: "domain",
          archived: false,
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toEqual({
      tenantId: "tenant_1",
      admissionRules: [
        {
          ruleId: "rule_1",
          effect: "allow",
          subject: { type: "domain", value: "example.com" },
          reason: "Employees",
          archived: false,
          archivedAt: null,
        },
      ],
      nextCursor: "rule_cursor_2",
    });

    const auditClient = makeClient({
      tenant_id: "tenant_1",
      audit_events: [
        {
          audit_event_id: "event_1",
          action: "access.grant.revoke",
          outcome: "success",
          actor: {
            type: "user",
            user_id: "user_1",
            name: "Ada",
            email: "ada@example.com",
          },
          target: { type: "grant", id: "grant_1" },
          reason_code: null,
          source_version: 42,
          request_id: "request_1",
          metadata: { objectType: "resource" },
          created_at: "2026-06-24T12:00:00.000Z",
        },
      ],
      next_cursor: "audit_cursor_2",
    });
    const auditActions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: auditClient,
    });
    await expect(
      getHandler(auditActions.listAuditEvents)(
        {},
        {
          tenantId: "tenant_1",
          cursor: "audit_cursor_1",
          limit: 20,
          actorType: "user",
          userId: "user_1",
          outcome: "success",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      tenantId: "tenant_1",
      auditEvents: [
        {
          auditEventId: "event_1",
          actor: { type: "user", userId: "user_1" },
          target: { type: "grant", id: "grant_1" },
        },
      ],
      nextCursor: "audit_cursor_2",
    });

    const invitationClient = makeClient({
      tenant_id: "tenant_1",
      invitations: [],
      next_cursor: "invitation_cursor_2",
    });
    const invitationActions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: invitationClient,
    });
    await expect(
      getHandler(invitationActions.listInvitations)(
        {},
        {
          tenantId: "tenant_1",
          cursor: "invitation_cursor_1",
          limit: 10,
          email: "person@example.com",
          targetType: "resource",
          resourceType: "documents",
          resourceId: "document_1",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toEqual({
      tenantId: "tenant_1",
      invitations: [],
      nextCursor: "invitation_cursor_2",
    });

    const headers = {
      "x-hercules-iam-actor": "user",
      "x-hercules-user-id-token": ID_TOKEN,
    };
    expect(admissionClient.get).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant_1/admission-rules?cursor=rule_cursor_1&limit=25&effect=allow&subject_type=domain&archived=false",
      { headers },
    );
    expect(auditClient.get).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant_1/audit-events?cursor=audit_cursor_1&limit=20&actor_type=user&user_id=user_1&outcome=success",
      { headers },
    );
    expect(invitationClient.get).toHaveBeenCalledWith(
      "/v1/iam/tenants/tenant_1/invitations?cursor=invitation_cursor_1&limit=10&email=person%40example.com&target_type=resource&resource_type=documents&resource_id=document_1",
      { headers },
    );
  });

  test("models invitation list filters as valid argument combinations", () => {
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: makeClient(),
    });
    const args = (actions.listInvitations as unknown as { args: { json: unknown } }).args;

    expect(args.json).toEqual({
      type: "union",
      value: expect.arrayContaining([
        expect.objectContaining({
          type: "object",
          value: expect.objectContaining({
            targetType: {
              fieldType: { type: "literal", value: "tenant" },
              optional: false,
            },
          }),
        }),
        expect.objectContaining({
          type: "object",
          value: expect.objectContaining({
            targetType: {
              fieldType: { type: "literal", value: "resource" },
              optional: false,
            },
          }),
        }),
        expect.objectContaining({
          type: "object",
          value: expect.objectContaining({
            resourceType: {
              fieldType: { type: "string" },
              optional: false,
            },
            resourceId: {
              fieldType: { type: "string" },
              optional: false,
            },
          }),
        }),
      ]),
    });
  });

  test("uses service authority without an app-user token", async () => {
    const client = makeClient();
    const actions = createIamServiceActions({
      internalAction: identityBuilder,
      client,
    });

    await getHandler(actions.archiveTenant)({}, { tenantId: "tenant_1" });

    expect(client.delete).toHaveBeenCalledWith("/v1/iam/tenants/tenant_1", {
      headers: { "x-hercules-iam-actor": "service" },
    });
  });

  test("returns grant ids for user permission overrides", async () => {
    const client = makeClient({
      ...API_RESULT,
      grants: [
        {
          grant_id: "grant_override_1",
          type: "permission",
          permission_id: "permission_1",
          permission_key: "tasks.read",
          effect: "allow",
          expires_at: null,
        },
      ],
    });
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await expect(
      getHandler(actions.listUserPermissionOverrides)(
        {},
        {
          tenantId: "tenant_1",
          userId: "user_1",
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toEqual({
      tenantId: "tenant_1",
      userId: "user_1",
      grants: [
        {
          grantId: "grant_override_1",
          type: "permission",
          permissionId: "permission_1",
          permissionKey: "tasks.read",
          effect: "allow",
          expiresAt: null,
        },
      ],
    });
  });

  test("supports permission resource invitations", async () => {
    const client = makeClient({
      ...API_RESULT,
      target: {
        type: "resource",
        resource_type: "documents",
        resource_id: "document_1",
        applies_to: "self",
      },
      grant: {
        conferral_id: "conferral_permission_read",
        type: "permission",
        permission_id: "permission_read",
        permission_key: "documents:read",
        effect: "allow",
        expires_at: null,
      },
    });
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await expect(
      getHandler(actions.createInvitation)(
        {},
        {
          tenantId: "tenant_1",
          email: "person@example.com",
          target: {
            type: "resource",
            resourceType: "documents",
            resourceId: "document_1",
            appliesTo: "self",
          },
          grant: {
            permissionKey: "documents:read",
            expiresAt: null,
          },
          idToken: ID_TOKEN,
        },
      ),
    ).resolves.toMatchObject({
      grant: {
        conferralId: "conferral_permission_read",
        type: "permission",
        permissionId: "permission_read",
        permissionKey: "documents:read",
        effect: "allow",
        expiresAt: null,
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/tenant_1/invitations", {
      headers: {
        "x-hercules-iam-actor": "user",
        "x-hercules-user-id-token": ID_TOKEN,
      },
      body: {
        email: "person@example.com",
        target: {
          type: "resource",
          resource_type: "documents",
          resource_id: "document_1",
          applies_to: "self",
        },
        grant: {
          permission_key: "documents:read",
          expires_at: null,
        },
      },
    });
  });

  test("keeps deployment entry separate from management actions", async () => {
    const client = makeClient();
    const action = createDeploymentEntryAction({
      authenticatedAction: identityBuilder,
      client,
    });
    const management = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await expect(getHandler(action)({}, { idToken: ID_TOKEN })).resolves.toEqual({
      tenantId: "tenant_1",
      userId: "user_1",
      allowed: true,
      reason: "open_allowed",
      status: "active",
      stateVersion: 4,
      changed: true,
    });
    expect(management).not.toHaveProperty("enterDeployment");
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants/default/entry", {
      headers: {
        "x-hercules-iam-actor": "user",
        "x-hercules-user-id-token": ID_TOKEN,
      },
      body: {},
    });
  });

  test("creates a tenant for the authenticated user with one role reference", async () => {
    const client = makeClient();
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://issuer.example|owner_1",
        }),
      },
    };

    await expect(
      createIamTenant(
        ctx,
        {
          name: "Acme",
          defaultRole: { key: "member" },
          entryMode: "invite_only",
        },
        { client },
      ),
    ).resolves.toEqual({
      tenantId: "tenant_1",
      created: true,
      sourceVersion: 4,
      projectionIds: ["projection_1"],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/tenants", {
      headers: { "x-hercules-iam-actor": "service" },
      body: {
        name: "Acme",
        owner_user_id: "owner_1",
        default_role: { key: "member" },
        entry_mode: "invite_only",
      },
    });
  });

  test("applies the tenant creation policy before writing", async () => {
    const client = makeClient();
    const canCreateTenant = vi.fn().mockResolvedValue(false);
    const action = createIamTenantAction({
      authenticatedAction: identityBuilder,
      canCreateTenant,
      client,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://issuer.example|owner_1",
        }),
      },
    };

    await expect(getHandler(action)(ctx, { name: "Acme" })).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED" },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  test("accepts invitations with a user token header", async () => {
    const client = makeClient({
      ...API_RESULT,
      grants: [
        {
          grant_id: "grant_1",
          type: "role",
          role_id: "role_1",
          expires_at: "2026-07-01T00:00:00.000Z",
          applies_to: "self_and_descendants",
        },
      ],
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://issuer.example|user_1",
        }),
      },
    };

    await expect(
      acceptIamInvitation(ctx, { token: "invitation_token", idToken: ID_TOKEN }, { client }),
    ).resolves.toMatchObject({
      tenantId: "tenant_1",
      invitationId: "invitation_1",
      grants: [
        {
          grantId: "grant_1",
          type: "role",
          roleId: "role_1",
          expiresAt: "2026-07-01T00:00:00.000Z",
          appliesTo: "self_and_descendants",
        },
      ],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/iam/invitations/accept", {
      headers: {
        "x-hercules-iam-actor": "user",
        "x-hercules-user-id-token": ID_TOKEN,
      },
      body: { token: "invitation_token" },
    });
  });

  test("rejects a user id passed in place of an ID token", async () => {
    const client = makeClient();
    const actions = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });

    await expect(
      getHandler(actions.updateTenant)(
        {},
        { tenantId: "tenant_1", name: "Acme", idToken: "user_1" },
      ),
    ).rejects.toMatchObject({
      data: { code: "INVALID_ID_TOKEN" },
    });
    expect(client.patch).not.toHaveBeenCalled();
  });
});
