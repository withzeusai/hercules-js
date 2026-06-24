import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { componentModules as modules } from "../../test/component-modules";
import schema from "./schema";

const applySync = makeFunctionReference<"mutation">("sync:applySync");
const authorize = makeFunctionReference<
  "query",
  Record<string, unknown>,
  {
    allowed: boolean;
    reasonCode: string;
    explicitDeny: boolean;
    effectiveRoleIds: string[];
  }
>("checks:authorize");
const authorizeMany = makeFunctionReference<
  "query",
  Record<string, unknown>,
  Array<{
    allowed: boolean;
    reasonCode: string;
    explicitDeny: boolean;
    effectiveRoleIds: string[];
  }>
>("checks:authorizeMany");
const getEffectivePermissions = makeFunctionReference<
  "query",
  Record<string, unknown>,
  { permissions: string[] }
>("queries:getEffectivePermissions");
const listTenantUserDirectory = makeFunctionReference<
  "query",
  Record<string, unknown>,
  {
    users: Array<{
      userId: string;
      name: string;
      email: string;
      image?: string;
      roles: Array<{
        roleId: string;
        roleKey: string;
        roleName: string;
        roleKind: "system" | "custom";
      }>;
    }>;
    cursor?: string;
  }
>("queries:listTenantUserDirectory");
const getTenantUserDirectoryEntry = makeFunctionReference<
  "query",
  Record<string, unknown>,
  {
    userId: string;
    name: string;
    email: string;
    image?: string;
    roles: Array<{
      roleId: string;
      roleKey: string;
      roleName: string;
      roleKind: "system" | "custom";
    }>;
  } | null
>("queries:getTenantUserDirectoryEntry");

const ISSUER = "https://auth.example.com";

type BindingAppliesTo = "self" | "self_and_descendants";

function hierarchySnapshot(options: {
  parentRoleAppliesTo?: BindingAppliesTo;
  childAllow?: boolean;
  ancestorDeny?: boolean;
  roleSubjectAncestorDeny?: boolean;
  resourceRoleSubjectAncestorDeny?: boolean;
}) {
  const roleBindings = [
    {
      bindingId: "rb_member",
      subjectPrincipalId: "principal_alice",
      roleId: "role_member",
      accessScopeId: "scope_default",
      appliesTo: "self" as const,
      updatedAt: 1,
    },
  ];
  if (options.parentRoleAppliesTo) {
    roleBindings.push({
      bindingId: "rb_parent_editor",
      subjectPrincipalId: "principal_alice",
      roleId: "role_task_editor",
      accessScopeId: "scope_default",
      resourceType: "app.project",
      resourceId: "project_1",
      appliesTo: options.parentRoleAppliesTo,
      updatedAt: 1,
    });
  }

  const permissionBindings = [];
  if (options.childAllow) {
    permissionBindings.push({
      bindingId: "pb_child_allow",
      subjectPrincipalId: "principal_alice",
      permissionId: "perm_task_edit",
      effect: "allow" as const,
      accessScopeId: "scope_default",
      resourceType: "app.task",
      resourceId: "task_1",
      appliesTo: "self" as const,
      updatedAt: 1,
    });
  }
  if (options.ancestorDeny) {
    permissionBindings.push({
      bindingId: "pb_parent_deny",
      subjectPrincipalId: "principal_alice",
      permissionId: "perm_task_edit",
      effect: "deny" as const,
      accessScopeId: "scope_default",
      resourceType: "app.project",
      resourceId: "project_1",
      appliesTo: "self_and_descendants" as const,
      updatedAt: 1,
    });
  }
  if (options.roleSubjectAncestorDeny) {
    permissionBindings.push({
      bindingId: "pb_parent_role_deny",
      subjectRoleId: "role_member",
      permissionId: "perm_task_edit",
      effect: "deny" as const,
      accessScopeId: "scope_default",
      resourceType: "app.project",
      resourceId: "project_1",
      appliesTo: "self_and_descendants" as const,
      updatedAt: 1,
    });
  }
  if (options.resourceRoleSubjectAncestorDeny) {
    permissionBindings.push({
      bindingId: "pb_parent_resource_role_deny",
      subjectRoleId: "role_task_editor",
      permissionId: "perm_task_edit",
      effect: "deny" as const,
      accessScopeId: "scope_default",
      resourceType: "app.project",
      resourceId: "project_1",
      appliesTo: "self_and_descendants" as const,
      updatedAt: 1,
    });
  }

  return {
    type: "access.projection.snapshot" as const,
    schemaVersion: 4 as const,
    eventId: "evt_hierarchy",
    mode: "initialize" as const,
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    catalog: {
      roles: [
        {
          roleId: "role_member",
          key: "member",
          source: "system" as const,
          name: "Member",
          description: null,
          baseWildcard: "none" as const,
          updatedAt: 1,
        },
        {
          roleId: "role_task_editor",
          key: "task_editor",
          source: "iam" as const,
          name: "Task editor",
          description: null,
          baseWildcard: "none" as const,
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_task_edit",
          key: "app.task:edit",
          resourceType: "app.task",
          action: "edit",
          classification: "delegable" as const,
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_task_editor",
          permissionId: "perm_task_edit",
          effect: "allow" as const,
          updatedAt: 1,
        },
      ],
    },
    users: [
      {
        herculesAuthUserId: "user_alice",
        name: "Alice",
        email: "alice@example.com",
        emailVerified: true,
        phoneVerified: false,
        updatedAt: 1,
      },
    ],
    scopes: [
      {
        scope: {
          accessScopeId: "scope_default",
          name: "Default",
          kind: "default" as const,
          status: "active" as const,
          accountEntryMode: "open" as const,
          defaultRoleId: "role_member",
          updatedAt: 1,
        },
        principals: [
          {
            principalId: "principal_alice",
            type: "user" as const,
            herculesAuthUserId: "user_alice",
            status: "active" as const,
            joinedAt: 1,
            updatedAt: 1,
          },
        ],
        principalMemberships: [],
        roles: [],
        rolePermissionOverrides: [],
        roleBindings,
        permissionBindings,
      },
    ],
  };
}

function checkTask(t: ReturnType<typeof convexTest>, ancestors: unknown[] = []) {
  return t.query(authorize, {
    tokenIdentifier: `${ISSUER}|user_alice`,
    tenantId: "scope_default",
    permission: "app.task:edit",
    resourceType: "app.task",
    resourceId: "task_1",
    ancestors,
  });
}

async function installSnapshot(
  t: ReturnType<typeof convexTest>,
  snapshot: ReturnType<typeof hierarchySnapshot>,
) {
  await expect(t.mutation(applySync, snapshot)).resolves.toMatchObject({
    ok: true,
    status: "applied",
  });
}

function directorySnapshot() {
  const snapshot = hierarchySnapshot({}) as ReturnType<typeof hierarchySnapshot> & {
    catalog: {
      permissions: Array<Record<string, unknown>>;
      rolePermissions: Array<Record<string, unknown>>;
    };
    users: Array<Record<string, unknown>>;
    scopes: Array<{
      principals: Array<Record<string, unknown>>;
      principalMemberships: Array<Record<string, unknown>>;
      roleBindings: Array<Record<string, unknown>>;
    }>;
  };
  snapshot.eventId = "evt_directory";
  snapshot.catalog.permissions.push({
    permissionId: "perm_members_read",
    key: "system.access.users:read",
    resourceType: "system.access.users",
    action: "read",
    classification: "delegable",
    tenantAssignable: false,
    updatedAt: 1,
  });
  snapshot.catalog.rolePermissions.push({
    roleId: "role_member",
    permissionId: "perm_members_read",
    effect: "allow",
    updatedAt: 1,
  });
  snapshot.users.push(
    {
      herculesAuthUserId: "user_bob",
      name: "Bob",
      email: "bob@example.com",
      emailVerified: true,
      image: "https://example.com/bob.png",
      phoneVerified: false,
      updatedAt: 1,
    },
    {
      herculesAuthUserId: "user_blocked",
      name: "Blocked",
      email: "blocked@example.com",
      emailVerified: true,
      phoneVerified: false,
      updatedAt: 1,
    },
  );
  snapshot.scopes[0]!.principals.push(
    {
      principalId: "principal_bob",
      type: "user",
      herculesAuthUserId: "user_bob",
      status: "active",
      joinedAt: 2,
      updatedAt: 2,
    },
    {
      principalId: "principal_blocked",
      type: "user",
      herculesAuthUserId: "user_blocked",
      status: "blocked",
      joinedAt: 3,
      updatedAt: 3,
    },
    {
      principalId: "principal_group",
      type: "group",
      name: "Engineering",
      status: "active",
      joinedAt: 4,
      updatedAt: 4,
    },
  );
  snapshot.scopes[0]!.roleBindings.push({
    bindingId: "rb_bob_task_editor",
    subjectPrincipalId: "principal_bob",
    roleId: "role_task_editor",
    accessScopeId: "scope_default",
    appliesTo: "self",
    updatedAt: 2,
  });
  snapshot.scopes[0]!.principalMemberships.push({
    groupPrincipalId: "principal_group",
    memberPrincipalId: "principal_bob",
    updatedAt: 2,
  });
  snapshot.scopes[0]!.roleBindings.push({
    bindingId: "rb_group_member",
    subjectPrincipalId: "principal_group",
    roleId: "role_member",
    accessScopeId: "scope_default",
    appliesTo: "self",
    updatedAt: 2,
  });
  return snapshot;
}

describe("hierarchical authorization", () => {
  test("sync rejects v4 bindings without appliesTo", async () => {
    const t = convexTest(schema, modules);
    const snapshot = hierarchySnapshot({ childAllow: true });
    delete (
      snapshot.scopes[0]!.permissionBindings[0] as {
        appliesTo?: BindingAppliesTo;
      }
    ).appliesTo;

    await expect(t.mutation(applySync, snapshot as never)).resolves.toEqual({
      ok: false,
      status: "invalid_payload",
    });
  });

  test("a parent role can confer the requested child permission", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ parentRoleAppliesTo: "self_and_descendants" }));

    await expect(
      checkTask(t, [{ resourceType: "app.project", resourceId: "project_1" }]),
    ).resolves.toMatchObject({
      allowed: true,
      effectiveRoleIds: ["role_member"],
    });
  });

  test("default self bindings preserve flat behavior", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ parentRoleAppliesTo: "self" }));

    await expect(
      checkTask(t, [{ resourceType: "app.project", resourceId: "project_1" }]),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });
  });

  test("an applicable ancestor deny overrides a child allow", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ childAllow: true, ancestorDeny: true }));

    await expect(
      checkTask(t, [{ resourceType: "app.project", resourceId: "project_1" }]),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
      explicitDeny: true,
    });
  });

  test("a role-subject ancestor deny overrides a child allow", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(
      t,
      hierarchySnapshot({ childAllow: true, roleSubjectAncestorDeny: true }),
    );

    await expect(
      checkTask(t, [{ resourceType: "app.project", resourceId: "project_1" }]),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
      explicitDeny: true,
    });
  });

  test("a resource-role ancestor deny overrides its child grant", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(
      t,
      hierarchySnapshot({
        parentRoleAppliesTo: "self_and_descendants",
        resourceRoleSubjectAncestorDeny: true,
      }),
    );

    await expect(
      checkTask(t, [{ resourceType: "app.project", resourceId: "project_1" }]),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
      explicitDeny: true,
    });
  });

  test("flat exact-resource checks remain unchanged without ancestors", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ childAllow: true }));

    await expect(checkTask(t)).resolves.toMatchObject({ allowed: true });
  });

  test("effective permissions support create-child checks against a parent", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ parentRoleAppliesTo: "self_and_descendants" }));

    await expect(
      t.query(getEffectivePermissions, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        resourceType: "app.task",
        ancestors: [{ resourceType: "app.project", resourceId: "project_1" }],
      }),
    ).resolves.toMatchObject({ permissions: ["app.task:edit"] });
  });

  test("rejects authorization chains longer than ten ancestors", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ childAllow: true }));

    await expect(
      checkTask(
        t,
        Array.from({ length: 11 }, (_unused, index) => ({
          resourceType: "app.folder",
          resourceId: `folder_${index}`,
        })),
      ),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "invalid_request" });
  });

  test("rejects duplicate authorization chains longer than ten ancestors", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({ childAllow: true }));

    await expect(
      checkTask(
        t,
        Array.from({ length: 11 }, () => ({
          resourceType: "app.project",
          resourceId: "project_1",
        })),
      ),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "invalid_request" });
  });
});

describe("tenant user directory", () => {
  test("paginates active user principals and returns only safe fields", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    const first = await t.query(listTenantUserDirectory, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_default",
      limit: 1,
    });
    expect(first.users).toHaveLength(1);
    expect(first.cursor).toEqual(expect.any(String));

    const second = await t.query(listTenantUserDirectory, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_default",
      cursor: first.cursor,
      limit: 100,
    });
    const users = [...first.users, ...second.users];
    expect(users).toEqual([
      {
        userId: "user_alice",
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
      {
        userId: "user_bob",
        name: "Bob",
        email: "bob@example.com",
        image: "https://example.com/bob.png",
        roles: [
          {
            roleId: "role_member",
            roleKey: "member",
            roleName: "Member",
            roleKind: "system",
          },
          {
            roleId: "role_task_editor",
            roleKey: "task_editor",
            roleName: "Task editor",
            roleKind: "custom",
          },
        ],
      },
    ]);
    expect(Object.keys(users[0]!).sort()).toEqual(["email", "name", "roles", "userId"]);
    expect(second.cursor).toBeUndefined();
  });

  test("resolves an active user by canonical user id", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        userId: "user_bob",
      }),
    ).resolves.toEqual({
      userId: "user_bob",
      name: "Bob",
      email: "bob@example.com",
      image: "https://example.com/bob.png",
      roles: [
        {
          roleId: "role_member",
          roleKey: "member",
          roleName: "Member",
          roleKind: "system",
        },
        {
          roleId: "role_task_editor",
          roleKey: "task_editor",
          roleName: "Task editor",
          roleKind: "custom",
        },
      ],
    });
  });

  test("requires a user id and rejects principal-id lookup fields", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        principalId: "principal_bob",
      }),
    ).rejects.toThrow();
  });

  test("hides inactive users and non-user principals", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
      }),
    ).rejects.toThrow();
    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        userId: "user_blocked",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        userId: "principal_group",
      }),
    ).resolves.toBeNull();
  });

  test("returns an empty page when the fixed user-read gate fails", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    await expect(
      t.query(listTenantUserDirectory, {
        tokenIdentifier: `${ISSUER}|user_blocked`,
        tenantId: "scope_default",
      }),
    ).resolves.toEqual({ users: [] });
    await expect(
      t.query(getTenantUserDirectoryEntry, {
        tokenIdentifier: `${ISSUER}|user_blocked`,
        tenantId: "scope_default",
        userId: "user_alice",
      }),
    ).resolves.toBeNull();
  });

  test("caps the directory limit at one hundred", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, directorySnapshot());

    await expect(
      t.query(listTenantUserDirectory, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        tenantId: "scope_default",
        limit: 101,
      }),
    ).rejects.toThrow();
  });
});

describe("batch authorization", () => {
  test("returns ordered concrete decisions in one component query", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(
      t,
      hierarchySnapshot({
        parentRoleAppliesTo: "self_and_descendants",
        ancestorDeny: true,
      }),
    );

    const decisions = await t.query(authorizeMany, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      checks: [
        {
          tenantId: "scope_default",
          permission: "app.task:edit",
          resourceType: "app.task",
          resourceId: "task_1",
          ancestors: [{ resourceType: "app.project", resourceId: "project_1" }],
        },
        {
          tenantId: "scope_default",
          permission: "app.task:edit",
          resourceType: "app.task",
          resourceId: "task_2",
          ancestors: [{ resourceType: "app.project", resourceId: "project_2" }],
        },
      ],
    });

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ allowed: false, explicitDeny: true });
    expect(decisions[1]).toMatchObject({ allowed: false });
  });

  test("rejects more than fifty checks", async () => {
    const t = convexTest(schema, modules);
    await installSnapshot(t, hierarchySnapshot({}));

    await expect(
      t.query(authorizeMany, {
        tokenIdentifier: `${ISSUER}|user_alice`,
        checks: Array.from({ length: 51 }, (_unused, index) => ({
          tenantId: "scope_default",
          permission: "app.task:edit",
          resourceType: "app.task",
          resourceId: `task_${index}`,
        })),
      }),
    ).rejects.toThrow("at most 50");
  });
});
