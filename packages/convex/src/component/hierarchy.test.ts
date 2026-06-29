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
          accessMode: "open" as const,
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
