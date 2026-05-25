import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import type { AccessProjectionSnapshot } from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);

const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const getEffectivePermissions = makeFunctionReference<"query">(
  "component/queries:getEffectivePermissions",
);
const listMyMemberships = makeFunctionReference<"query">("component/queries:listMyMemberships");
const listMyRoles = makeFunctionReference<"query">("component/queries:listMyRoles");

const ISSUER = "https://auth.example.com";

function emptyEntities() {
  return {
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
    schemaVersion: 1,
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
    expect(byScope.get("scope_default")?.roleKey).toBe("owner");
    expect(byScope.get("scope_default")?.kind).toBe("default");
    expect(byScope.get("scope_acme")?.roleKey).toBe("admin");
    expect(byScope.get("scope_acme")?.kind).toBe("org");
    expect(byScope.get("scope_default")?.joinedAt).toBe(1001);
    expect(byScope.get("scope_acme")?.joinedAt).toBe(1002);
  });

  test("returns all roles for a membership in one scope", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, {
      type: "access.projection.snapshot",
      schemaVersion: 1,
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
            updatedAt: 1,
          },
          {
            roleId: "role_field_agent",
            accessScopeId: "scope_acme",
            key: "field_agent",
            kind: "custom",
            name: "Field Agent",
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
        { roleId: "role_field_agent", roleKey: "field_agent", roleName: "Field Agent" },
        { roleId: "role_loan_officer", roleKey: "loan_officer", roleName: "Loan Officer" },
      ],
    });
    expect(memberships[0]?.roleKey).toBe("field_agent");
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
  test("returns additive role permissions with contribution-level overrides and user exceptions", async () => {
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
      permissions: ["borrowers.create", "reports.export"],
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
});

function permissionCatalogSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
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
          updatedAt: 1,
        },
        {
          roleId: "role_accountant",
          accessScopeId: "scope_default",
          key: "accountant",
          kind: "system",
          name: "Accountant",
          updatedAt: 1,
        },
        {
          roleId: "role_field_agent",
          accessScopeId: "scope_default",
          key: "field_agent",
          kind: "system",
          name: "Field Agent",
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
    schemaVersion: 1,
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
    schemaVersion: 1,
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
    schemaVersion: 1,
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
