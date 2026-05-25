import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import type { AccessProjectionSnapshot } from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);

const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const authorize = makeFunctionReference<"query">("component/checks:authorize");

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

function defaultScopeSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
    eventId: "evt_seed",
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
          roleId: "role_admin",
          accessScopeId: "scope_default",
          key: "admin",
          kind: "system",
          name: "Admin",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_tasks_create",
          accessScopeId: "scope_default",
          key: "tasks:create",
          resourceType: "tasks",
          action: "create",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_admin",
          permissionId: "perm_tasks_create",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_admin",
          subjectPrincipalId: "p_alice",
          relationKind: "role",
          roleId: "role_admin",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_default",
          updatedAt: 1,
        },
      ],
    },
  };
}

describe("authorize", () => {
  test("denies when token identifier missing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {});
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("missing_identity");
  });

  test("authenticated mode allows before first sync (cold start, CRIT-03)", async () => {
    const t = convexTest(schema, modules);
    // No mutation: sync_state row does not exist yet. Authenticated mode
    // (no permission requested) should still allow on token presence so
    // the user's first updateCurrentUser call can run.
    const decision = await t.query(authorize, { tokenIdentifier: `${ISSUER}|user_alice` });
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("allowed");
  });

  test("permission mode denies when sync_state is not initialised yet", async () => {
    const t = convexTest(schema, modules);
    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("mirror_not_ready");
  });

  test("denies when issuer does not match", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: "https://attacker.example.com|user_alice",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("unexpected_issuer");
  });

  test("authenticated mode (no permission, no scopeId) allows on issuer match", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, { tokenIdentifier: `${ISSUER}|user_anyone` });
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("allowed");
  });

  test("permission mode requires scopeId", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("scope_missing");
  });

  test("permission mode denies on disabled scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    await t.mutation(applySync, {
      type: "access.projection.event",
      schemaVersion: 1,
      eventId: "evt_disable",
      sourceVersion: 2,
      scope: {
        accessScopeId: "scope_default",
        name: "Default",
        kind: "default",
        status: "disabled",
        accountEntryMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 2,
      },
      changes: [],
      entities: emptyEntities(),
    });

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("scope_disabled");
  });

  test("permission mode allows when role grants permission", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.principalId).toBe("p_alice");
    expect(decision.effectiveRoleIds).toEqual(["role_admin"]);
  });

  test("permission mode ignores deny role grants", async () => {
    const t = convexTest(schema, modules);
    const snapshot = defaultScopeSnapshot();
    snapshot.entities.grants = [
      {
        grantId: "grant_alice_admin_deny",
        subjectPrincipalId: "p_alice",
        relationKind: "role",
        roleId: "role_admin",
        effect: "deny",
        objectType: "scope",
        objectId: "scope_default",
        updatedAt: 1,
      },
    ];
    await t.mutation(applySync, snapshot);

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_denied");
    expect(decision.effectiveRoleIds).toEqual([]);
  });

  test("permission mode denies when permission key is unknown in the scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:delete",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_missing");
  });

  test("permission mode denies a suspended principal", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    await t.mutation(applySync, {
      type: "access.projection.event",
      schemaVersion: 1,
      eventId: "evt_suspend",
      sourceVersion: 2,
      scope: {
        accessScopeId: "scope_default",
        name: "Default",
        kind: "default",
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 2,
      },
      changes: [{ entityType: "principal", entityId: "p_alice", operation: "upsert" }],
      entities: {
        ...emptyEntities(),
        principals: [
          {
            principalId: "p_alice",
            type: "user",
            herculesAuthUserId: "user_alice",
            status: "suspended",
            joinedAt: 100,
            updatedAt: 200,
          },
        ],
      },
    });

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_suspended");
  });

  test("role override deny only removes that role contribution and user deny wins globally", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, accessCatalogSnapshot());
    await t.mutation(applySync, acmeOrgSnapshot());

    const reportDecision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      permission: "reports.export",
    });
    expect(reportDecision.allowed).toBe(true);
    expect(reportDecision.effectiveRoleIds).toEqual([
      "role_manager",
      "role_accountant",
      "role_field_agent",
    ]);

    const loansDecision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      permission: "loans.read",
    });
    expect(loansDecision.allowed).toBe(false);
    expect(loansDecision.reasonCode).toBe("permission_denied");
  });
});

function accessCatalogSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
    eventId: "evt_access_catalog",
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

function acmeOrgSnapshot(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
    eventId: "evt_acme_org",
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
      ],
    },
  };
}
