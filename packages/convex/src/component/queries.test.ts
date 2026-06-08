import { convexTest as baseConvexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import type { AccessProjectionSnapshot } from "../shared/sync";
import { withV3SyncFixtures } from "../../test/legacy-sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);

const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const getEffectivePermissions = makeFunctionReference<"query">(
  "component/queries:getEffectivePermissions",
);
const listMyMemberships = makeFunctionReference<"query">(
  "component/queries:listMyMemberships",
);
const listMyRoles = makeFunctionReference<"query">(
  "component/queries:listMyRoles",
);
const listScopeMembers = makeFunctionReference<"query">(
  "component/queries:listScopeMembers",
);
const listScopeRoles = makeFunctionReference<"query">(
  "component/queries:listScopeRoles",
);
const listScopePermissions = makeFunctionReference<"query">(
  "component/queries:listScopePermissions",
);
const listDirectSubjectsForResource = makeFunctionReference<"query">(
  "component/queries:listDirectSubjectsForResource",
);

const ISSUER = "https://auth.example.com";
const convexTest = (...args: Parameters<typeof baseConvexTest>) =>
  withV3SyncFixtures(baseConvexTest(...args));

function emptyEntities() {
  return {
    users: [],
    principals: [],
    principalMemberships: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    grants: [],
  };
}

function memberSnapshot(
  scopeId: string,
  scopeName: string,
  scopeKind: "default" | "org",
  scopeStatus: "active" | "disabled",
  options: {
    userPrincipalId: string;
    roleId: string;
    grantId: string;
    sourceVersion: number;
    eventId: string;
  },
): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: options.eventId,
    sourceVersion: options.sourceVersion,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: scopeId,
      name: scopeName,
      kind: scopeKind,
      status: scopeStatus,
      accountEntryMode: "open",
      defaultRoleId: options.roleId,
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: options.userPrincipalId,
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 1000 + options.sourceVersion,
          updatedAt: 1000 + options.sourceVersion,
        },
      ],
      roles: [
        {
          roleId: options.roleId,
          accessScopeId: scopeId,
          key: scopeKind === "default" ? "owner" : "admin",
          kind: "system",
          name: scopeKind === "default" ? "Owner" : "Admin",
          wildcard: scopeKind === "default" ? "immutable" : "default",
          updatedAt: 1,
        },
      ],
      grants: [
        {
          grantId: options.grantId,
          subjectPrincipalId: options.userPrincipalId,
          relationKind: "role",
          roleId: options.roleId,
          effect: "allow",
          objectType: "scope",
          objectId: scopeId,
          updatedAt: 1,
        },
      ],
    },
  };
}

function effectiveRoleReadSnapshot(options: {
  grants: AccessProjectionSnapshot["entities"]["grants"];
  roles: AccessProjectionSnapshot["entities"]["roles"];
}): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_effective_role_reads",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: "p_alice",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 1001,
          updatedAt: 1,
        },
        {
          principalId: "p_engineering",
          type: "group",
          status: "active",
          joinedAt: 1000,
          updatedAt: 1,
        },
      ],
      principalMemberships: [
        {
          groupPrincipalId: "p_engineering",
          memberPrincipalId: "p_alice",
          updatedAt: 1,
        },
      ],
      roles: options.roles,
      grants: options.grants,
    },
  };
}

describe("listMyMemberships", () => {
  test("returns memberships across multiple active scopes", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );
    await t.mutation(
      applySync,
      memberSnapshot("scope_acme", "Acme", "org", "active", {
        userPrincipalId: "p_alice_acme",
        roleId: "role_acme_admin",
        grantId: "grant_alice_acme",
        sourceVersion: 2,
        eventId: "evt_acme",
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(2);
    const byScope = new Map(memberships.map((m) => [m.scopeId, m]));
    expect(byScope.get("scope_default")?.roles[0]?.roleKey).toBe("owner");
    expect(byScope.get("scope_default")?.kind).toBe("default");
    expect(byScope.get("scope_acme")?.roles[0]?.roleKey).toBe("admin");
    expect(byScope.get("scope_acme")?.kind).toBe("org");
    expect(byScope.get("scope_default")?.joinedAt).toBe(1001);
    expect(byScope.get("scope_acme")?.joinedAt).toBe(1002);
  });

  test("returns all roles for a membership in one scope", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, {
      type: "access.projection.snapshot",
      schemaVersion: 2,
      eventId: "evt_multi_role",
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_acme",
        name: "Acme",
        kind: "org",
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: "role_loan_officer",
        updatedAt: 1,
      },
      entities: {
        ...emptyEntities(),
        principals: [
          {
            principalId: "p_alice_acme",
            type: "user",
            herculesAuthUserId: "user_alice",
            status: "active",
            joinedAt: 1001,
            updatedAt: 1001,
          },
        ],
        roles: [
          {
            roleId: "role_loan_officer",
            accessScopeId: "scope_acme",
            key: "loan_officer",
            kind: "custom",
            name: "Loan Officer",
            wildcard: "none",
            updatedAt: 1,
          },
          {
            roleId: "role_field_agent",
            accessScopeId: "scope_acme",
            key: "field_agent",
            kind: "custom",
            name: "Field Agent",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        grants: [
          {
            grantId: "grant_alice_loan_officer",
            subjectPrincipalId: "p_alice_acme",
            relationKind: "role",
            roleId: "role_loan_officer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
          {
            grantId: "grant_alice_field_agent",
            subjectPrincipalId: "p_alice_acme",
            relationKind: "role",
            roleId: "role_field_agent",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
        ],
      },
    } satisfies AccessProjectionSnapshot);

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      scopeId: "scope_acme",
      roles: [
        {
          roleId: "role_field_agent",
          roleKey: "field_agent",
          roleName: "Field Agent",
        },
        {
          roleId: "role_loan_officer",
          roleKey: "loan_officer",
          roleName: "Loan Officer",
        },
      ],
    });
  });

  test("lists roles for one scope", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_acme", "Acme", "org", "active", {
        userPrincipalId: "p_alice_acme",
        roleId: "role_acme_admin",
        grantId: "grant_alice_acme",
        sourceVersion: 1,
        eventId: "evt_acme",
      }),
    );

    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });

    expect(roles).toEqual([
      {
        roleId: "role_acme_admin",
        roleKey: "admin",
        roleName: "Admin",
        roleKind: "system",
      },
    ]);
  });

  test("lists roles inherited through direct group membership", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      effectiveRoleReadSnapshot({
        roles: [
          {
            roleId: "role_engineer",
            accessScopeId: "scope_acme",
            key: "engineer",
            kind: "custom",
            name: "Engineer",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        grants: [
          {
            grantId: "grant_engineering_engineer",
            subjectPrincipalId: "p_engineering",
            relationKind: "role",
            roleId: "role_engineer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
        ],
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });
    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });

    expect(memberships[0]?.roles).toEqual([
      {
        roleId: "role_engineer",
        roleKey: "engineer",
        roleName: "Engineer",
        roleKind: "custom",
      },
    ]);
    expect(roles).toEqual(memberships[0]?.roles);
  });

  test("role deny overrides direct and group role allows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      effectiveRoleReadSnapshot({
        roles: [
          {
            roleId: "role_engineer",
            accessScopeId: "scope_acme",
            key: "engineer",
            kind: "custom",
            name: "Engineer",
            wildcard: "none",
            updatedAt: 1,
          },
          {
            roleId: "role_viewer",
            accessScopeId: "scope_acme",
            key: "viewer",
            kind: "custom",
            name: "Viewer",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        grants: [
          {
            grantId: "grant_alice_engineer",
            subjectPrincipalId: "p_alice",
            relationKind: "role",
            roleId: "role_engineer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
          {
            grantId: "grant_engineering_engineer",
            subjectPrincipalId: "p_engineering",
            relationKind: "role",
            roleId: "role_engineer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
          {
            grantId: "grant_engineering_viewer",
            subjectPrincipalId: "p_engineering",
            relationKind: "role",
            roleId: "role_viewer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
          {
            grantId: "deny_engineering_engineer",
            subjectPrincipalId: "p_engineering",
            relationKind: "role",
            roleId: "role_engineer",
            effect: "deny",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 2,
          },
        ],
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });
    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });

    expect(memberships[0]?.roles).toEqual([
      {
        roleId: "role_viewer",
        roleKey: "viewer",
        roleName: "Viewer",
        roleKind: "custom",
      },
    ]);
    expect(roles).toEqual(memberships[0]?.roles);
  });

  test("skips disabled scopes", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );
    await t.mutation(
      applySync,
      memberSnapshot("scope_archived", "Archived", "org", "disabled", {
        userPrincipalId: "p_alice_archived",
        roleId: "role_archived_admin",
        grantId: "grant_alice_archived",
        sourceVersion: 2,
        eventId: "evt_archived",
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.scopeId).toBe("scope_default");
  });

  test("returns empty list when user has no principals", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_other",
        roleId: "role_owner",
        grantId: "grant_other",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_unknown`,
    });
    expect(memberships).toEqual([]);
  });

  test("returns empty when sync_state issuer does not match", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: "https://other.example.com|user_alice",
    });
    expect(memberships).toEqual([]);
  });
});

describe("getEffectivePermissions", () => {
  test("applies explicit role denies across all assigned roles", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, permissionCatalogSnapshot());
    await t.mutation(applySync, permissionOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });

    expect(result).toMatchObject({
      allowed: true,
      reasonCode: "allowed",
      sourceVersion: 2,
      principalId: "p_alice_acme",
      scopeId: "scope_acme",
      effectiveRoleIds: ["role_manager", "role_accountant", "role_field_agent"],
      permissions: ["borrowers.create"],
    });
  });

  test("only includes resource grants for the requested resource", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    const withoutResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });
    expect(withoutResource.permissions).toEqual([]);

    const withResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(withResource.permissions).toEqual(["reports.read"]);

    const otherResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_456",
    });
    expect(otherResource.permissions).toEqual([]);
  });

  test("applies a role-wide resource allow with a specific deny exception", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceRoleCatalogSnapshot());
    await t.mutation(applySync, resourceRoleOrgSnapshot());

    const ordinaryReport = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(ordinaryReport.permissions).toEqual(["reports.read"]);

    const blockedReport = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_private",
    });
    expect(blockedReport.permissions).toEqual([]);
  });

  test("does not authorize a resource rule for a missing role", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceRoleOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(result.permissions).toEqual([]);
  });

  test("reports a manage-action permission held via a non-wildcard role", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, manageCatalogSnapshot());
    await t.mutation(applySync, manageOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
    });

    // A `manage` (and a `*`) catalog permission held via a custom role must be
    // reported by membership; re-evaluating with the permission's own superset
    // action would never match and would drop it.
    expect(result.wildcard).toBe("none");
    expect(result.permissions).toEqual([
      "system.access.roles:manage",
      "system.access.roles:read",
      "system.reports:*",
      "system.reports:export",
    ]);
  });
});

function manageCatalogSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_manage_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      permissions: [
        {
          permissionId: "perm_roles_manage",
          accessScopeId: "scope_default",
          key: "system.access.roles:manage",
          resourceType: "system.access.roles",
          action: "manage",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_roles_read",
          accessScopeId: "scope_default",
          key: "system.access.roles:read",
          resourceType: "system.access.roles",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_reports_all",
          accessScopeId: "scope_default",
          key: "system.reports:*",
          resourceType: "system.reports",
          action: "*",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_reports_export",
          accessScopeId: "scope_default",
          key: "system.reports:export",
          resourceType: "system.reports",
          action: "export",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_loans_read",
          accessScopeId: "scope_default",
          key: "loans.read",
          resourceType: "loans",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
    },
  };
}

function manageOrgSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_manage_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_role_admin",
      updatedAt: 2,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: "p_alice_acme",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
      ],
      roles: [
        {
          roleId: "role_role_admin",
          accessScopeId: "scope_acme",
          key: "role_admin",
          kind: "custom",
          name: "Role Admin",
          wildcard: "none",
          updatedAt: 2,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_role_admin",
          permissionId: "perm_roles_manage",
          accessScopeId: "scope_acme",
          effect: "allow",
          updatedAt: 2,
        },
        {
          roleId: "role_role_admin",
          permissionId: "perm_reports_all",
          accessScopeId: "scope_acme",
          effect: "allow",
          updatedAt: 2,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_role_admin",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_role_admin",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
      ],
    },
  };
}

function permissionCatalogSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_permission_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_manager",
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      roles: [
        {
          roleId: "role_manager",
          accessScopeId: "scope_default",
          key: "manager",
          kind: "system",
          name: "Manager",
          wildcard: "none",
          updatedAt: 1,
        },
        {
          roleId: "role_accountant",
          accessScopeId: "scope_default",
          key: "accountant",
          kind: "system",
          name: "Accountant",
          wildcard: "none",
          updatedAt: 1,
        },
        {
          roleId: "role_field_agent",
          accessScopeId: "scope_default",
          key: "field_agent",
          kind: "system",
          name: "Field Agent",
          wildcard: "none",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_reports_export",
          accessScopeId: "scope_default",
          key: "reports.export",
          resourceType: "reports",
          action: "export",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_loans_read",
          accessScopeId: "scope_default",
          key: "loans.read",
          resourceType: "loans",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_borrowers_create",
          accessScopeId: "scope_default",
          key: "borrowers.create",
          resourceType: "borrowers",
          action: "create",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_manager",
          permissionId: "perm_reports_export",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
        },
        {
          roleId: "role_manager",
          permissionId: "perm_loans_read",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
        },
        {
          roleId: "role_accountant",
          permissionId: "perm_reports_export",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
        },
        {
          roleId: "role_field_agent",
          permissionId: "perm_loans_read",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
        },
      ],
    },
  };
}

function permissionOrgSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_permission_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_manager",
      updatedAt: 2,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: "p_alice_acme",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_manager",
          permissionId: "perm_reports_export",
          accessScopeId: "scope_acme",
          effect: "deny",
          updatedAt: 2,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_manager",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_manager",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_alice_accountant",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_accountant",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_alice_field_agent",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_field_agent",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_alice_loans_read_deny",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_loans_read",
          effect: "deny",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_alice_borrowers_create_allow",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_borrowers_create",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
      ],
    },
  };
}

function resourceCatalogSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_resource_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      permissions: [
        {
          permissionId: "perm_reports_read",
          accessScopeId: "scope_default",
          key: "reports.read",
          resourceType: "reports",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
    },
  };
}

function resourceOrgSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_resource_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 2,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: "p_alice_acme",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_report_123_read",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "allow",
          objectType: "resource",
          objectId: "report_123",
          objectResourceType: "reports",
          updatedAt: 2,
        },
      ],
    },
  };
}

function resourceRoleCatalogSnapshot(): AccessProjectionSnapshot {
  const snapshot = resourceCatalogSnapshot();
  return {
    ...snapshot,
    eventId: "evt_resource_role_catalog",
    entities: {
      ...snapshot.entities,
      roles: [
        {
          roleId: "role_viewer",
          accessScopeId: "scope_default",
          key: "viewer",
          kind: "system",
          name: "Viewer",
          wildcard: "none",
          updatedAt: 1,
        },
      ],
    },
  };
}

function resourceRoleOrgSnapshot(): AccessProjectionSnapshot {
  const snapshot = resourceOrgSnapshot();
  return {
    ...snapshot,
    eventId: "evt_resource_role_org",
    entities: {
      ...snapshot.entities,
      grants: [
        {
          grantId: "grant_alice_viewer",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_viewer",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_viewer_reports_read",
          subjectRoleId: "role_viewer",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "allow",
          objectType: "resource",
          objectId: "*",
          objectResourceType: "reports",
          updatedAt: 2,
        },
        {
          grantId: "grant_viewer_private_report_block",
          subjectRoleId: "role_viewer",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "deny",
          objectType: "resource",
          objectId: "report_private",
          objectResourceType: "reports",
          updatedAt: 2,
        },
      ],
    },
  };
}

// A resource share grant as the producer projects it — IDENTICAL in shape
// whether it originated from an accepted resource invitation or an immediate
// resource grant (both resolve to one principal-subject, resource-object,
// direct_permission grant). The component only sees the projected row, so
// getEffectivePermissions must enumerate the same permission set for both.
type ResourceShareGrant = {
  grantId: string;
  effect: "allow" | "deny";
  objectId: string;
  objectResourceType?: string;
};

// The permission catalog is app-wide and always lives in the DEFAULT scope
// (effective.ts fetches catalogPermissions there). Seed the permission, the
// principal, the Viewer role membership, and the resource grants all in the
// default scope so getEffectivePermissions can enumerate over the catalog.
function resourceShareEnumSnapshot(
  grants: ResourceShareGrant[],
): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_resource_share_enum",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
      principals: [
        {
          principalId: "p_alice",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
      ],
      roles: [
        {
          roleId: "role_viewer",
          accessScopeId: "scope_default",
          key: "viewer",
          kind: "system",
          name: "Viewer",
          wildcard: "none",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_reports_read",
          accessScopeId: "scope_default",
          key: "reports.read",
          resourceType: "reports",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_viewer",
          subjectPrincipalId: "p_alice",
          relationKind: "role",
          roleId: "role_viewer",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_default",
          updatedAt: 1,
        },
        ...grants.map((grant) => ({
          grantId: grant.grantId,
          subjectPrincipalId: "p_alice",
          relationKind: "direct_permission" as const,
          permissionId: "perm_reports_read",
          effect: grant.effect,
          objectType: "resource" as const,
          objectId: grant.objectId,
          objectResourceType: grant.objectResourceType,
          updatedAt: 1,
        })),
      ],
    },
  };
}

function effectiveReportPermissions(
  t: ReturnType<typeof convexTest>,
  resourceId: string,
): Promise<string[]> {
  return t
    .query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      resourceType: "reports",
      resourceId,
    })
    .then((result) => result.permissions);
}

// getEffectivePermissions must enumerate IDENTICALLY for a permission reached
// via an accepted resource invitation vs an equivalent immediate resource
// grant: same projected row, same enumerated set.
describe("getEffectivePermissions — resource invitation / immediate grant parity", () => {
  test("ordinary resource share allow enumerates identically for both origins", async () => {
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_immediate",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );
    const invitation = convexTest(schema, modules);
    await invitation.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_invitation",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );

    const fromImmediate = await effectiveReportPermissions(
      immediate,
      "report_1",
    );
    const fromInvitation = await effectiveReportPermissions(
      invitation,
      "report_1",
    );
    expect(fromImmediate).toEqual(["reports.read"]);
    expect(fromInvitation).toEqual(fromImmediate);
  });

  test("an inherited deny overrides the resource share identically for both origins", async () => {
    // A scope-wide all-instances ("*") deny overrides the instance allow.
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_immediate",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
        {
          grantId: "grant_inherited_deny",
          effect: "deny",
          objectId: "*",
          objectResourceType: "reports",
        },
      ]),
    );
    const invitation = convexTest(schema, modules);
    await invitation.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_invitation",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
        {
          grantId: "grant_inherited_deny",
          effect: "deny",
          objectId: "*",
          objectResourceType: "reports",
        },
      ]),
    );

    const fromImmediate = await effectiveReportPermissions(
      immediate,
      "report_1",
    );
    const fromInvitation = await effectiveReportPermissions(
      invitation,
      "report_1",
    );
    expect(fromImmediate).toEqual([]);
    expect(fromInvitation).toEqual(fromImmediate);
  });

  test("a malformed-resourceType grant enumerates nothing for both origins", async () => {
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
        { grantId: "grant_immediate", effect: "allow", objectId: "report_1" },
      ]),
    );
    const invitation = convexTest(schema, modules);
    await invitation.mutation(
      applySync,
      resourceShareEnumSnapshot([
        { grantId: "grant_invitation", effect: "allow", objectId: "report_1" },
      ]),
    );

    const fromImmediate = await effectiveReportPermissions(
      immediate,
      "report_1",
    );
    const fromInvitation = await effectiveReportPermissions(
      invitation,
      "report_1",
    );
    expect(fromImmediate).toEqual([]);
    expect(fromInvitation).toEqual(fromImmediate);

    // Positive control: same shape with a well-formed resourceType enumerates
    // the permission, so the empty sets above are attributable to the malformed
    // type alone.
    const wellFormed = convexTest(schema, modules);
    await wellFormed.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_well_formed",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );
    expect(await effectiveReportPermissions(wellFormed, "report_1")).toEqual([
      "reports.read",
    ]);
  });
});

describe("scope admin reads", () => {
  // Default scope with the system read permissions in the catalog, an Owner
  // (immutable wildcard, so it passes any read gate), and a plain Member
  // (no permissions). The catalog must contain the gated key or the gate
  // denies, so the read permissions are seeded explicitly.
  function adminReadSnapshot(): AccessProjectionSnapshot {
    return {
      type: "access.projection.snapshot",
      schemaVersion: 2,
      eventId: "evt_admin_read",
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_default",
        name: "Default",
        kind: "default",
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 1,
      },
      entities: {
        ...emptyEntities(),
        users: [
          {
            herculesAuthUserId: "user_owner",
            name: "Olivia Owner",
            email: "olivia@example.com",
            emailVerified: true,
            phoneVerified: false,
            updatedAt: 1,
          },
          {
            herculesAuthUserId: "user_member",
            name: "Mia Member",
            email: "mia@example.com",
            emailVerified: true,
            phoneVerified: false,
            updatedAt: 1,
          },
        ],
        permissions: [
          {
            permissionId: "perm_members_read",
            accessScopeId: "scope_default",
            key: "system.members:read",
            resourceType: "system.members",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_roles_read",
            accessScopeId: "scope_default",
            key: "system.roles:read",
            resourceType: "system.roles",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_permissions_read",
            accessScopeId: "scope_default",
            key: "system.permissions:read",
            resourceType: "system.permissions",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_posts_read",
            accessScopeId: "scope_default",
            key: "posts:read",
            resourceType: "posts",
            action: "read",
            tenantAssignable: true,
            updatedAt: 1,
          },
        ],
        roles: [
          {
            roleId: "role_owner",
            accessScopeId: "scope_default",
            key: "owner",
            kind: "system",
            name: "Owner",
            wildcard: "immutable",
            updatedAt: 1,
          },
          {
            roleId: "role_member",
            accessScopeId: "scope_default",
            key: "member",
            kind: "system",
            name: "Member",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        principals: [
          {
            principalId: "p_owner",
            type: "user",
            herculesAuthUserId: "user_owner",
            status: "active",
            joinedAt: 1001,
            updatedAt: 1001,
          },
          {
            principalId: "p_member",
            type: "user",
            herculesAuthUserId: "user_member",
            status: "active",
            joinedAt: 1002,
            updatedAt: 1002,
          },
        ],
        grants: [
          {
            grantId: "grant_owner",
            subjectPrincipalId: "p_owner",
            relationKind: "role",
            roleId: "role_owner",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_default",
            updatedAt: 1,
          },
          {
            grantId: "grant_member",
            subjectPrincipalId: "p_member",
            relationKind: "role",
            roleId: "role_member",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_default",
            updatedAt: 1,
          },
        ],
      },
    };
  }

  test("owner lists members with roles; unprivileged member gets an empty list", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    const asOwner = await t.query(listScopeMembers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      scopeId: "scope_default",
    });
    expect(asOwner.map((m) => m.herculesAuthUserId).sort()).toEqual([
      "user_member",
      "user_owner",
    ]);
    const owner = asOwner.find((m) => m.herculesAuthUserId === "user_owner");
    expect(owner?.name).toBe("Olivia Owner");
    expect(owner?.roles[0]?.roleKey).toBe("owner");

    const asMember = await t.query(listScopeMembers, {
      tokenIdentifier: `${ISSUER}|user_member`,
      scopeId: "scope_default",
    });
    expect(asMember).toEqual([]);
  });

  test("owner lists roles and the permission catalog; member is denied both", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    const roles = await t.query(listScopeRoles, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      scopeId: "scope_default",
    });
    expect(roles.map((r) => r.roleKey).sort()).toEqual(["member", "owner"]);

    const permissions = await t.query(listScopePermissions, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      scopeId: "scope_default",
    });
    expect(permissions.map((p) => p.key)).toContain("posts:read");
    expect(permissions.map((p) => p.key)).toContain("system.members:read");

    expect(
      await t.query(listScopeRoles, {
        tokenIdentifier: `${ISSUER}|user_member`,
        scopeId: "scope_default",
      }),
    ).toEqual([]);
    expect(
      await t.query(listScopePermissions, {
        tokenIdentifier: `${ISSUER}|user_member`,
        scopeId: "scope_default",
      }),
    ).toEqual([]);
  });
});

describe("listDirectSubjectsForResource", () => {
  test("lists direct grantees on the resource for an authorized caller", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
      permission: "reports.read",
    });

    expect(subjects).toEqual([
      expect.objectContaining({
        principalId: "p_alice_acme",
        permissionKey: "reports.read",
        effect: "allow",
      }),
    ]);
  });

  test("returns [] when the caller lacks the permission on that resource", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    // alice holds reports.read on report_123, but not on report_456.
    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_456",
      permission: "reports.read",
    });
    expect(subjects).toEqual([]);
  });
});
