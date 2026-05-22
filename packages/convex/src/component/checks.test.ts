import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import type { AccessProjectionSnapshot } from "../shared/sync";

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
    roleAssignments: [],
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
          key: "admin",
          kind: "system",
          name: "Admin",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_tasks_create",
          key: "tasks:create",
          resourceType: "tasks",
          action: "create",
          updatedAt: 1,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_admin",
          permissionId: "perm_tasks_create",
          updatedAt: 1,
        },
      ],
      roleAssignments: [
        {
          assignmentId: "ra_alice_admin",
          principalId: "p_alice",
          roleId: "role_admin",
          targetType: "scope",
          targetId: "scope_default",
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

  test("denies when sync_state is not initialised yet", async () => {
    const t = convexTest(schema, modules);
    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
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

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_anyone`,
    });
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
});
