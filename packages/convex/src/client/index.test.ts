import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { ComponentApi } from "../_generated/component";
import {
  DEFAULT_TENANT_SENTINEL,
  PERMISSION_RESOURCE_TYPE_SENTINEL,
  createIam,
  tenantFromArg,
  tenantFromDefaultParentResource,
  tenantFromDefaultResource,
  tenantFromParentResource,
  tenantFromResource,
  type IamComponent,
} from "./index";

// A stand-in for Convex's query/mutation/action builders: returns the function
// definition unchanged so the tests can pull `.handler` back out. Typed as
// `never` so it satisfies the precise QueryBuilder/MutationBuilder/ActionBuilder
// parameter types the factory expects without reconstructing those builder types.
const identityBuilder = ((definition: unknown) => definition) as never;

const component = {
  checks: { authorize: "authorize", authorizeMany: "authorizeMany" },
  queries: {
    getTenantAccessStatus: "getTenantAccessStatus",
    listMyTenants: "listMyTenants",
    listMyActiveTenants: "listMyActiveTenants",
    getTargetTenantSyncStatus: "getTargetTenantSyncStatus",
    listMyRoles: "listMyRoles",
    getEffectivePermissions: "getEffectivePermissions",
    getTenant: "getTenant",
    listTenantUsers: "listTenantUsers",
    listTenantGroups: "listTenantGroups",
    listTenantUserDirectory: "listTenantUserDirectory",
    listTenantMemberPickerUsers: "listTenantMemberPickerUsers",
    listResourceSharingRecipients: "listResourceSharingRecipients",
    getTenantUserDirectoryEntry: "getTenantUserDirectoryEntry",
    listGroupMembers: "listGroupMembers",
    listUserGroups: "listUserGroups",
    listTenantRoles: "listTenantRoles",
    getTenantRole: "getTenantRole",
    listTenantPermissions: "listTenantPermissions",
    getResourcePermissionOverrides: "getResourcePermissionOverrides",
    explainAccess: "explainAccess",
    listDirectSubjectsForResource: "listDirectSubjectsForResource",
  },
};

describe("createIam", () => {
  test("accepts the generated component API type", () => {
    expectTypeOf<ComponentApi<"hercules">>().toMatchTypeOf<IamComponent>();
  });

  test("resolves the Hercules-mounted component by default", () => {
    const herculesComponent = {
      ...component,
      checks: { authorize: "herculesAuthorize" },
    };
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      components: { hercules: herculesComponent },
    });
    const definition = builders.authenticatedQuery({
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        effectiveRoleIds: [],
      }),
    };

    return definition.handler(ctx).then(() => {
      expect(ctx.runQuery).toHaveBeenCalledWith("herculesAuthorize", expect.any(Object));
    });
  });

  test("requires IAM builders to declare a permission", () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });

    expect(() =>
      builders.iamMutation({
        args: {},
        tenant: tenantFromArg("tenantId"),
        handler: async () => null,
      } as never),
    ).toThrow("iam* builders require a non-empty permission.");
  });

  test("returns the canonical Hercules Auth user id from the verified identity", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          subject: "auth_user_1",
          tokenIdentifier: "https://auth.example.com|different_suffix",
        }),
      },
      runQuery: vi.fn(),
    };

    await expect(builders.getCurrentHerculesAuthUserId(ctx as never)).resolves.toBe("auth_user_1");
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("returns undefined when there is no authenticated user", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: { getUserIdentity: vi.fn().mockResolvedValue(null) },
      runQuery: vi.fn(),
    };

    await expect(builders.getCurrentHerculesAuthUserId(ctx as never)).resolves.toBeUndefined();
  });

  test("defaults IAM builders to the default tenant", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.iamMutation({
      permission: "tasks:create",
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        sourceVersion: 1,
        principalId: "principal_1",
        effectiveRoleIds: ["role_member"],
      }),
    };

    await expect(handler.handler(ctx, {})).resolves.toBe("ok");
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: DEFAULT_TENANT_SENTINEL,
      permission: "tasks:create",
      resourceType: undefined,
      resourceId: undefined,
    });
  });

  test("authenticated builders fail closed when authorization denies", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.authenticatedQuery({
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: false,
        reasonCode: "unexpected_issuer",
        effectiveRoleIds: [],
      }),
    };

    await expect(handler.handler(ctx)).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: undefined,
      permission: undefined,
      resourceType: undefined,
      resourceId: undefined,
    });
  });

  test("IAM builders pass the extracted tenant and permission to the component check", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.iamMutation({
      permission: "appointments:create",
      tenant: tenantFromArg("tenantId"),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        sourceVersion: 1,
        principalId: "principal_1",
        effectiveRoleIds: ["role_member"],
      }),
    };

    await expect(handler.handler(ctx, { tenantId: "tenant_abc" })).resolves.toBe("ok");
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      permission: "appointments:create",
      resourceType: undefined,
      resourceId: undefined,
    });
  });

  test("read helpers use the configured IAM component", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(async (ref: string) => {
        if (ref === "authorize") {
          return {
            allowed: true,
            reasonCode: "allowed",
            sourceVersion: 1,
            principalId: "principal_1",
            effectiveRoleIds: ["role_member"],
          };
        }
        if (ref === "getEffectivePermissions") {
          return {
            allowed: true,
            reasonCode: "allowed",
            sourceVersion: 1,
            tenantId: "tenant_abc",
            principalId: "principal_1",
            effectiveRoleIds: ["role_member"],
            wildcard: "none",
            permissions: ["tasks.read"],
          };
        }
        if (ref === "getTenantAccessStatus") {
          return {
            kind: "principal",
            principalId: "principal_1",
            status: "active",
            stateVersion: 1,
          };
        }
        if (ref === "listMyTenants") {
          return {
            tenants: [
              {
                tenantId: "tenant_abc",
                tenantName: "Acme",
                isRoot: false,
                roles: [
                  {
                    roleId: "role_member",
                    roleKey: "member",
                    roleName: "Member",
                    roleKind: "system",
                  },
                ],
                joinedAt: 1,
                accessStatus: "active",
                lifecycleStatus: "active",
              },
            ],
            cursor: "tenant_cursor_2",
          };
        }
        if (ref === "listMyActiveTenants") {
          return {
            tenants: [
              {
                tenantId: "tenant_abc",
                tenantName: "Acme",
                isRoot: false,
                roles: [],
                joinedAt: 1,
                accessStatus: "active",
                lifecycleStatus: "active",
              },
            ],
            cursor: "active_tenant_cursor_2",
          };
        }
        if (ref === "getTargetTenantSyncStatus") {
          return {
            state: "ready",
            currentSourceVersion: 8,
            targetSourceVersion: 8,
            tenantId: "tenant_abc",
            principalId: "principal_1",
          };
        }
        if (ref === "getTenant") {
          return {
            tenantId: "tenant_abc",
            tenantName: "Acme",
            isRoot: false,
            lifecycleStatus: "disabled",
            accessMode: "open",
            defaultRoleId: "role_member",
            updatedAt: 1,
          };
        }
        if (ref === "listMyRoles") {
          return [
            {
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roleKind: "system",
            },
          ];
        }
        if (ref === "listTenantUserDirectory") {
          return {
            users: [
              {
                userId: "user_1",
                name: "Alice",
                email: "alice@example.com",
                roles: [
                  {
                    roleId: "role_member",
                    roleKey: "member",
                    roleName: "Member",
                    roleKind: "system",
                  },
                ],
              },
            ],
            cursor: "cursor_2",
          };
        }
        if (ref === "listTenantMemberPickerUsers") {
          return {
            users: [
              {
                userId: "user_1",
                name: "Alice",
                email: "alice@example.com",
              },
            ],
            cursor: "member_picker_cursor_2",
          };
        }
        if (ref === "listResourceSharingRecipients") {
          return {
            recipients: [
              {
                type: "group",
                groupId: "group_1",
                name: "Reviewers",
              },
            ],
            cursor: "recipient_cursor_2",
          };
        }
        if (ref === "getTenantUserDirectoryEntry") {
          return {
            userId: "user_1",
            name: "Alice",
            email: "alice@example.com",
            roles: [
              {
                roleId: "role_member",
                roleKey: "member",
                roleName: "Member",
                roleKind: "system",
              },
            ],
          };
        }
        if (ref === "listTenantUsers") {
          return {
            users: [
              {
                userId: "user_1",
                status: "active",
                joinedAt: 1,
                roles: [],
                directRoleGrants: [],
              },
            ],
            cursor: "users_cursor_2",
          };
        }
        if (ref === "listTenantGroups") {
          return {
            groups: [
              {
                groupId: "group_1",
                status: "active",
                joinedAt: 1,
                memberCount: 1,
                roles: [],
                directRoleGrants: [],
              },
            ],
            cursor: "groups_cursor_2",
          };
        }
        if (ref === "listGroupMembers") {
          return {
            users: [
              {
                userId: "user_1",
                status: "active",
                joinedAt: 1,
                roles: [],
                directRoleGrants: [],
              },
            ],
            cursor: "members_cursor_2",
          };
        }
        if (ref === "listUserGroups") {
          return {
            groups: [
              {
                groupId: "group_1",
                status: "active",
                joinedAt: 1,
                memberCount: 1,
                roles: [],
                directRoleGrants: [],
              },
            ],
            cursor: "user_groups_cursor_2",
          };
        }
        if (ref === "listDirectSubjectsForResource") {
          return {
            subjects: [
              {
                type: "user",
                userId: "user_1",
                status: "active",
                grant: {
                  grantId: "grant_1",
                  type: "permission",
                  permissionId: "permission_1",
                  permissionKey: "tasks.read",
                  effect: "allow",
                  expiresAt: null,
                  appliesTo: "self",
                },
              },
            ],
            cursor: "subjects_cursor_2",
          };
        }
        if (ref === "authorizeMany") {
          return [
            {
              allowed: true,
              reasonCode: "allowed",
              sourceVersion: 1,
              principalId: "principal_1",
              effectiveRoleIds: ["role_member"],
            },
          ];
        }
        throw new Error(`Unexpected query ref ${ref}`);
      }),
    };

    await expect(
      builders.hasPermission(ctx as never, {
        tenantId: "tenant_abc",
        permission: "tasks.read",
        resource: { type: "tasks", id: "task_1" },
      }),
    ).resolves.toBe(true);
    await expect(
      builders.getEffectivePermissions(ctx as never, {
        tenantId: "tenant_abc",
        resource: { type: "app.projects" },
      }),
    ).resolves.toEqual(["tasks.read"]);
    await expect(builders.getTenantAccessStatus(ctx as never)).resolves.toEqual({
      kind: "principal",
      principalId: "principal_1",
      status: "active",
      stateVersion: 1,
    });
    await expect(
      builders.listMyTenants(ctx as never, { cursor: "tenant_cursor_1", limit: 25 }),
    ).resolves.toEqual({
      tenants: [
        {
          tenantId: "tenant_abc",
          tenantName: "Acme",
          isRoot: false,
          roles: [
            {
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roleKind: "system",
            },
          ],
          joinedAt: 1,
          accessStatus: "active",
          lifecycleStatus: "active",
        },
      ],
      nextCursor: "tenant_cursor_2",
    });
    await expect(
      builders.listMyActiveTenants(ctx as never, {
        cursor: "active_tenant_cursor_1",
        limit: 25,
        isRoot: false,
      }),
    ).resolves.toEqual({
      tenants: [
        {
          tenantId: "tenant_abc",
          tenantName: "Acme",
          isRoot: false,
          roles: [],
          joinedAt: 1,
          accessStatus: "active",
          lifecycleStatus: "active",
        },
      ],
      nextCursor: "active_tenant_cursor_2",
    });
    await expect(
      builders.getTargetTenantSyncStatus(ctx as never, {
        tenantId: "tenant_abc",
        sourceVersion: 8,
      }),
    ).resolves.toEqual({
      state: "ready",
      currentSourceVersion: 8,
      targetSourceVersion: 8,
      tenantId: "tenant_abc",
      principalId: "principal_1",
    });
    await expect(builders.getTenant(ctx as never, { tenantId: "tenant_abc" })).resolves.toEqual({
      tenantId: "tenant_abc",
      tenantName: "Acme",
      isRoot: false,
      lifecycleStatus: "archived",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    });
    await expect(builders.listMyRoles(ctx as never, { tenantId: "tenant_abc" })).resolves.toEqual([
      {
        roleId: "role_member",
        roleKey: "member",
        roleName: "Member",
        roleKind: "system",
      },
    ]);
    await expect(
      builders.listTenantUserDirectory(ctx as never, {
        tenantId: "tenant_abc",
        cursor: "cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      users: [
        {
          userId: "user_1",
          name: "Alice",
          email: "alice@example.com",
          roles: [
            {
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roleKind: "system",
            },
          ],
        },
      ],
      nextCursor: "cursor_2",
    });
    await expect(
      builders.listTenantMemberPickerUsers(ctx as never, {
        tenantId: "tenant_abc",
        permission: "app.tasks:assign",
        resource: { type: "app.tasks", id: "task_1" },
        ancestors: [{ type: "app.projects", id: "project_1" }],
        cursor: "member_picker_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      users: [
        {
          userId: "user_1",
          name: "Alice",
          email: "alice@example.com",
        },
      ],
      nextCursor: "member_picker_cursor_2",
    });
    await expect(
      builders.listResourceSharingRecipients(ctx as never, {
        tenantId: "tenant_abc",
        permission: "app.docs:manage_members",
        resourceType: "app.docs",
        resourceId: "doc_1",
        ancestors: [{ type: "app.folders", id: "folder_1" }],
        recipientType: "group",
        cursor: "recipient_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      recipients: [
        {
          type: "group",
          groupId: "group_1",
          name: "Reviewers",
        },
      ],
      nextCursor: "recipient_cursor_2",
    });
    await expect(
      builders.getTenantUserDirectoryEntry(ctx as never, {
        tenantId: "tenant_abc",
        userId: "user_1",
      }),
    ).resolves.toEqual({
      userId: "user_1",
      name: "Alice",
      email: "alice@example.com",
      roles: [
        {
          roleId: "role_member",
          roleKey: "member",
          roleName: "Member",
          roleKind: "system",
        },
      ],
    });
    await expect(
      builders.listTenantUsers(ctx as never, {
        tenantId: "tenant_abc",
        cursor: "users_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      users: [
        {
          userId: "user_1",
          status: "active",
          joinedAt: 1,
          roles: [],
          directRoleGrants: [],
        },
      ],
      nextCursor: "users_cursor_2",
    });
    await expect(
      builders.listTenantGroups(ctx as never, {
        tenantId: "tenant_abc",
        cursor: "groups_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      groups: [
        {
          groupId: "group_1",
          status: "active",
          joinedAt: 1,
          memberCount: 1,
          roles: [],
          directRoleGrants: [],
        },
      ],
      nextCursor: "groups_cursor_2",
    });
    await expect(
      builders.listGroupMembers(ctx as never, {
        tenantId: "tenant_abc",
        groupId: "group_1",
        cursor: "members_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      users: [
        {
          userId: "user_1",
          status: "active",
          joinedAt: 1,
          roles: [],
          directRoleGrants: [],
        },
      ],
      nextCursor: "members_cursor_2",
    });
    await expect(
      builders.listUserGroups(ctx as never, {
        tenantId: "tenant_abc",
        userId: "user_1",
        cursor: "user_groups_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      groups: [
        {
          groupId: "group_1",
          status: "active",
          joinedAt: 1,
          memberCount: 1,
          roles: [],
          directRoleGrants: [],
        },
      ],
      nextCursor: "user_groups_cursor_2",
    });
    await expect(
      builders.listDirectSubjectsForResource(ctx as never, {
        tenantId: "tenant_abc",
        resourceType: "tasks",
        resourceId: "task_1",
        cursor: "subjects_cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      subjects: [
        {
          type: "user",
          userId: "user_1",
          status: "active",
          grant: {
            grantId: "grant_1",
            type: "permission",
            permissionId: "permission_1",
            permissionKey: "tasks.read",
            effect: "allow",
            expiresAt: null,
            appliesTo: "self",
          },
        },
      ],
      nextCursor: "subjects_cursor_2",
    });
    await expect(
      builders.checkPermissions(ctx as never, [
        {
          tenantId: "tenant_abc",
          permission: "tasks.read",
          resource: { type: "tasks", id: "task_1" },
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        allowed: true,
        reasonCode: "allowed",
      }),
    ]);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      permission: "tasks.read",
      resourceType: "tasks",
      resourceId: "task_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getEffectivePermissions", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      resourceType: "app.projects",
      resourceId: undefined,
      ancestors: undefined,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getTenantAccessStatus", {
      tokenIdentifier: "https://auth.example.com|user_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listMyTenants", {
      tokenIdentifier: "https://auth.example.com|user_1",
      cursor: "tenant_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listMyActiveTenants", {
      tokenIdentifier: "https://auth.example.com|user_1",
      cursor: "active_tenant_cursor_1",
      limit: 25,
      isRoot: false,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getTargetTenantSyncStatus", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      sourceVersion: 8,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getTenant", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listTenantUserDirectory", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      cursor: "cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listTenantMemberPickerUsers", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      permission: "app.tasks:assign",
      resourceType: "app.tasks",
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
      cursor: "member_picker_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listResourceSharingRecipients", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      permission: "app.docs:manage_members",
      resourceType: "app.docs",
      resourceId: "doc_1",
      ancestors: [{ resourceType: "app.folders", resourceId: "folder_1" }],
      recipientType: "group",
      cursor: "recipient_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getTenantUserDirectoryEntry", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      userId: "user_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listTenantUsers", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      cursor: "users_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listTenantGroups", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      cursor: "groups_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listDirectSubjectsForResource", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_abc",
      resourceType: "tasks",
      resourceId: "task_1",
      cursor: "subjects_cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("authorizeMany", {
      tokenIdentifier: "https://auth.example.com|user_1",
      checks: [
        {
          tenantId: "tenant_abc",
          permission: "tasks.read",
          resourceType: "tasks",
          resourceId: "task_1",
          ancestors: undefined,
        },
      ],
    });
  });

  test("hasPermission forwards a bounded explicit ancestor chain atomically", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        effectiveRoleIds: [],
      }),
    };

    await expect(
      builders.hasPermission(ctx, {
        tenantId: "tenant_1",
        permission: "app.tasks:update",
        resource: { type: "app.tasks", id: "task_1" },
        ancestors: [{ type: "app.projects", id: "project_1" }],
      }),
    ).resolves.toBe(true);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_1",
      permission: "app.tasks:update",
      resourceType: "app.tasks",
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });

  test("hasPermission accepts a permission key and defaults to the app scope", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        sourceVersion: 1,
        principalId: "principal_1",
        effectiveRoleIds: ["role_member"],
      }),
    };

    await expect(builders.hasPermission(ctx, "tasks.create")).resolves.toBe(true);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: DEFAULT_TENANT_SENTINEL,
      permission: "tasks.create",
      resourceType: undefined,
      resourceId: undefined,
    });
  });

  test("filterAuthorizedResources keeps only the rows the caller can access", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(async (_ref: string, args: { checks: Array<{ resourceId: string }> }) =>
        args.checks.map((check) => ({
          allowed: check.resourceId === "p1",
          reasonCode: check.resourceId === "p1" ? "allowed" : "permission_denied",
          effectiveRoleIds: [],
        })),
      ),
    };

    const rows = [
      { _id: "p1", title: "A" },
      { _id: "p2", title: "B" },
    ];
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: rows,
      permission: "app.project:view",
      tenantId: "tenant_1",
      resource: (row) => ({ type: "app.project", id: row._id }),
    });

    expect(result).toEqual([{ _id: "p1", title: "A" }]);
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorizeMany", {
      tokenIdentifier: "https://auth.example.com|user_1",
      checks: [
        {
          tenantId: "tenant_1",
          permission: "app.project:view",
          resourceType: "app.project",
          resourceId: "p1",
          ancestors: undefined,
        },
        {
          tenantId: "tenant_1",
          permission: "app.project:view",
          resourceType: "app.project",
          resourceId: "p2",
          ancestors: undefined,
        },
      ],
    });
  });

  test("filterAuthorizedResources includes rows allowed by an ancestor", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(async (_ref: string, args: { checks: Array<{ ancestors?: unknown[] }> }) =>
        args.checks.map((check) => ({
          allowed: check.ancestors?.length === 1,
          reasonCode: "allowed",
          effectiveRoleIds: [],
        })),
      ),
    };

    const rows = [{ _id: "task_1", projectId: "project_1" }];
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: rows,
      permission: "app.tasks:read",
      tenantId: "tenant_1",
      resource: (row) => ({ type: "app.tasks", id: row._id }),
      ancestors: (row) => [{ type: "app.projects", id: row.projectId }],
    });

    expect(result).toEqual(rows);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorizeMany", {
      tokenIdentifier: "https://auth.example.com|user_1",
      checks: [
        {
          tenantId: "tenant_1",
          permission: "app.tasks:read",
          resourceType: "app.tasks",
          resourceId: "task_1",
          ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
        },
      ],
    });
  });

  test("filterAuthorizedResources excludes rows denied by an ancestor", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue([
        {
          allowed: false,
          reasonCode: "explicit_deny",
          effectiveRoleIds: [],
        },
      ]),
    };

    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: [{ _id: "task_1", projectId: "project_1" }],
      permission: "app.tasks:read",
      resource: (row) => ({ type: "app.tasks", id: row._id }),
      ancestors: (row) => [{ type: "app.projects", id: row.projectId }],
    });

    expect(result).toEqual([]);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorizeMany", {
      tokenIdentifier: "https://auth.example.com|user_1",
      checks: [
        expect.objectContaining({
          ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
        }),
      ],
    });
  });

  test("filterAuthorizedResources batches authorizeMany in chunks of at most fifty and preserves row order", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(async (_ref: string, args: { checks: Array<{ resourceId?: string }> }) =>
        args.checks.map((check) => ({
          allowed: Number(check.resourceId?.slice(1)) % 2 === 0,
          reasonCode: "allowed",
          effectiveRoleIds: [],
        })),
      ),
    };
    const rows = Array.from({ length: 121 }, (_unused, index) => ({
      id: `r${index}`,
    }));

    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: rows,
      permission: "app.rows:read",
      tenantId: "tenant_1",
      resource: (row) => ({ type: "app.rows", id: row.id }),
    });

    expect(result.map((row) => row.id)).toEqual(
      rows.filter((row) => Number(row.id.slice(1)) % 2 === 0).map((row) => row.id),
    );
    expect(ctx.runQuery).toHaveBeenCalledTimes(3);
    expect(ctx.runQuery.mock.calls.map(([, args]) => args.checks)).toEqual([
      expect.arrayContaining([expect.objectContaining({ resourceId: "r0" })]),
      expect.arrayContaining([expect.objectContaining({ resourceId: "r50" })]),
      expect.arrayContaining([expect.objectContaining({ resourceId: "r100" })]),
    ]);
    expect(ctx.runQuery.mock.calls.map(([, args]) => args.checks.length)).toEqual([50, 50, 21]);
  });

  test("filterAuthorizedResources returns [] when the caller is unauthenticated", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: { getUserIdentity: vi.fn().mockResolvedValue(null) },
      runQuery: vi.fn(),
    };
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: [{ _id: "p1" }],
      permission: "app.project:view",
      resource: (row) => ({ type: "app.project", id: row._id }),
    });
    expect(result).toEqual([]);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("IAM builders surface a ConvexError when tenant extraction returns no tenant", async () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.iamMutation({
      permission: "appointments:create",
      tenant: tenantFromArg("tenantId"),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(),
    };

    await expect(handler.handler(ctx, {})).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("tenantFromResource reads the tenant field from the loaded row", async () => {
    const extract = tenantFromResource("loans", "loanId");
    const ctx = {
      db: { get: vi.fn().mockResolvedValue({ tenantId: "tenant_xyz" }) },
    };
    // The resource type defers to the checked permission's canonical catalog
    // type (sentinel substituted by the authorize gate), NOT the table name:
    // resource grants are pinned to the catalog type, so emitting the table
    // name would make every resource-scoped check deny.
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      tenantId: "tenant_xyz",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "loan_1",
    });
    expect(ctx.db.get).toHaveBeenCalledWith("loan_1");
  });

  test("tenantFromResource accepts a custom tenantField", async () => {
    const extract = tenantFromResource("loans", "loanId", {
      tenantField: "accessScopeId",
    });
    const ctx = {
      db: { get: vi.fn().mockResolvedValue({ accessScopeId: "scope_custom" }) },
    };
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      tenantId: "scope_custom",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "loan_1",
    });
  });

  test("tenantFromResource throws when the row is missing the tenant field", async () => {
    const extract = tenantFromResource("loans", "loanId");
    const ctx = { db: { get: vi.fn().mockResolvedValue({}) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("tenantFromResource hierarchy (authorizeAgainst)", () => {
  function makeTaskMutation(
    authorizeAgainst?: (row: Record<string, unknown>) => Array<{ type: string; id: string }>,
  ) {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    return builders.iamMutation({
      permission: "app.task:edit",
      tenant: tenantFromResource("tasks", "taskId", { authorizeAgainst }),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as {
      handler: (ctx: unknown, args: unknown) => Promise<unknown>;
    };
  }

  function makeCtx(
    runQuery: ReturnType<typeof vi.fn>,
    row: Record<string, unknown> = {
      tenantId: "tenant_1",
      projectId: "proj_1",
    },
  ) {
    return {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery,
      db: { get: vi.fn().mockResolvedValue(row) },
    };
  }

  test("allows via an ancestor when the resource itself is implicitly denied", async () => {
    const handler = makeTaskMutation((task) => [
      {
        type: "app.project",
        id: String(task.projectId),
      },
    ]);
    const runQuery = vi.fn(async () => ({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    }));
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      tenantId: "tenant_1",
      permission: "app.task:edit",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.project", resourceId: "proj_1" }],
    });
  });

  test("returns an atomic deny from the target and ancestor evaluation", async () => {
    const handler = makeTaskMutation((task) => [
      {
        type: "app.project",
        id: String(task.projectId),
      },
    ]);
    const runQuery = vi.fn().mockResolvedValue({
      allowed: false,
      reasonCode: "permission_denied",
      explicitDeny: true,
      effectiveRoleIds: [],
    });

    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).rejects.toBeInstanceOf(
      ConvexError,
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("always sends declared ancestors even when the target itself allows", async () => {
    const handler = makeTaskMutation((task) => [
      { type: "app.project", id: String(task.projectId) },
    ]);
    const runQuery = vi.fn().mockResolvedValue({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("default path without authorizeAgainst makes exactly one authorize call", async () => {
    const handler = makeTaskMutation();
    const runQuery = vi.fn().mockResolvedValue({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("rejects an over-long ancestor chain before any authorize call", async () => {
    const handler = makeTaskMutation(() =>
      Array.from({ length: 11 }, (_unused, i) => ({
        type: "app.project",
        id: `p${i}`,
      })),
    );
    const runQuery = vi.fn().mockResolvedValue({
      allowed: false,
      reasonCode: "denied",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).rejects.toBeInstanceOf(
      ConvexError,
    );
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("tenantFromParentResource authorizes child creation against its loaded parent", async () => {
    const extract = tenantFromParentResource("projects", "projectId", {
      parentResourceType: "app.projects",
      authorizeAgainst: (project) => [{ type: "app.workspaces", id: String(project.workspaceId) }],
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
        }),
      },
    };

    await expect(extract(ctx as never, { projectId: "project_1" })).resolves.toEqual({
      tenantId: "tenant_1",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: [
        { resourceType: "app.projects", resourceId: "project_1" },
        { resourceType: "app.workspaces", resourceId: "workspace_1" },
      ],
    });
  });
});

describe("default-tenant resource extractors", () => {
  test("tenantFromDefaultResource loads a row without a stored tenant id", async () => {
    const extract = tenantFromDefaultResource("documents", "documentId");
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "document_1", title: "Draft" }),
      },
    };

    await expect(extract(ctx as never, { documentId: "document_1" })).resolves.toEqual({
      tenantId: DEFAULT_TENANT_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "document_1",
    });
  });

  test("tenantFromDefaultResource includes trusted ancestors from the loaded row", async () => {
    const extract = tenantFromDefaultResource("tasks", "taskId", {
      authorizeAgainst: (task) => [{ type: "app.projects", id: String(task.projectId) }],
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "task_1", projectId: "project_1" }),
      },
    };

    await expect(extract(ctx as never, { taskId: "task_1" })).resolves.toEqual({
      tenantId: DEFAULT_TENANT_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });

  test("tenantFromDefaultParentResource authorizes creation against a loaded parent", async () => {
    const extract = tenantFromDefaultParentResource("projects", "projectId", {
      parentResourceType: "app.projects",
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "project_1", name: "Roadmap" }),
      },
    };

    await expect(extract(ctx as never, { projectId: "project_1" })).resolves.toEqual({
      tenantId: DEFAULT_TENANT_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });
});
