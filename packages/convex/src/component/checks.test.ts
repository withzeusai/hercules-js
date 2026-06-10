import { convexTest as baseConvexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { componentModules as modules } from "../../test/component-modules";
import { withV3SyncFixtures, type LegacySnapshot } from "../../test/legacy-sync";
import schema from "./schema";

// The behavioral fixtures below are authored in the pre-v3 (schemaVersion 2)
// shape; withV3SyncFixtures upgrades them to the v3 wire shape before forwarding
// to the real applySync mutation. AccessProjectionSnapshot is the v3 type, so the
// fixtures are typed with the legacy shape instead.
type Snapshot = LegacySnapshot;

const applySync = makeFunctionReference<"mutation">("sync:applySync");
const authorize = makeFunctionReference<"query">("checks:authorize");

const ISSUER = "https://auth.example.com";
const convexTest = (schemaArg: typeof schema, modulesArg: typeof modules) =>
  withV3SyncFixtures(baseConvexTest(schemaArg, modulesArg));

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

function defaultScopeSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
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
          // Narrowed Admin (enumerated): the producer downgrades Admin to
          // "none" once explicit role-permission rows exist, so these legacy
          // enumerated assertions stay deterministic. Wildcard-Admin behavior
          // is covered by the dedicated wildcard suite below.
          wildcard: "none",
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
      schemaVersion: 2,
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

  // NOTE: the v2-era "deny role grant" tests were removed. In the v3 model a
  // role_binding is additive-only — it has no `effect` column on the wire or in
  // the schema (effective.ts: "there is no deny role binding on the wire, so
  // membership is purely additive"). A subject is denied a role's authority by a
  // role_permission deny / direct permission_binding deny, which is covered by
  // authz.test.ts (deny-override) and parity-ingest.test.ts.

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

  test("rejects a resource type that disagrees with the catalog permission", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
      resourceType: "folders",
      resourceId: "folder_1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("invalid_request");
  });

  test("permission mode denies a suspended principal", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    await t.mutation(applySync, {
      type: "access.projection.event",
      schemaVersion: 2,
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

  // "removed" is the MANUAL admin-eviction state (split out of "blocked").
  // Ingestion must accept it on the wire, and the runtime must treat it as
  // non-active exactly like blocked/suspended.
  test("permission mode denies a removed principal", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, defaultScopeSnapshot());

    const ingest = await t.mutation(applySync, {
      type: "access.projection.event",
      schemaVersion: 2,
      eventId: "evt_remove",
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
            status: "removed",
            joinedAt: 100,
            updatedAt: 200,
          },
        ],
      },
    });
    expect(ingest).toMatchObject({ ok: true, status: "applied", acknowledgedVersion: 2 });

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_removed");
  });

  test("per-instance role grant grants the role's permissions on that instance only", async () => {
    const t = convexTest(schema, modules);
    const snapshot = defaultScopeSnapshot();
    snapshot.entities.roles[0]!.kind = "custom";
    snapshot.entities.roles[0]!.key = "task_admin";
    snapshot.entities.roles[0]!.name = "Task Admin";
    // Replace the scope-level role grant with a role granted on a single
    // resource instance (relationKind="role" + objectType="resource"), the
    // shape the producer emits for grantResourceAccess(role).
    snapshot.entities.grants = [
      {
        grantId: "grant_alice_admin_task_1",
        subjectPrincipalId: "p_alice",
        relationKind: "role",
        roleId: "role_admin",
        effect: "allow",
        objectType: "resource",
        objectId: "task_1",
        objectResourceType: "tasks",
        updatedAt: 1,
      },
    ];
    await expect(t.mutation(applySync, snapshot)).resolves.toEqual({
      ok: true,
      status: "applied",
      acknowledgedVersion: 1,
    });

    const onInstance = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
      resourceType: "tasks",
      resourceId: "task_1",
    });
    expect(onInstance.allowed).toBe(true);
    expect(onInstance.principalId).toBe("p_alice");
    expect(onInstance.effectiveRoleIds).toEqual([]);

    // A different instance of the same type is not covered by the grant.
    const otherInstance = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
      resourceType: "tasks",
      resourceId: "task_2",
    });
    expect(otherInstance.allowed).toBe(false);
    expect(otherInstance.reasonCode).toBe("permission_denied");

    // No instance scoping at all => the type-level request is not granted.
    const typeLevel = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
    });
    expect(typeLevel.allowed).toBe(false);
    expect(typeLevel.reasonCode).toBe("permission_denied");
  });

  test("resource role deny overrides another allow on the same instance", async () => {
    const t = convexTest(schema, modules);
    const snapshot = defaultScopeSnapshot();
    snapshot.entities.roles[0]!.kind = "custom";
    snapshot.entities.roles[0]!.key = "task_restricted";
    snapshot.entities.roles[0]!.name = "Task Restricted";
    snapshot.entities.rolePermissions = [
      {
        roleId: "role_admin",
        permissionId: "perm_tasks_create",
        accessScopeId: "scope_default",
        effect: "deny",
        updatedAt: 1,
      },
    ];
    snapshot.entities.grants = [
      {
        grantId: "grant_alice_task_restricted",
        subjectPrincipalId: "p_alice",
        relationKind: "role",
        roleId: "role_admin",
        effect: "allow",
        objectType: "resource",
        objectId: "task_1",
        objectResourceType: "tasks",
        updatedAt: 1,
      },
      {
        grantId: "grant_alice_task_create",
        subjectPrincipalId: "p_alice",
        relationKind: "direct_permission",
        permissionId: "perm_tasks_create",
        effect: "allow",
        objectType: "resource",
        objectId: "task_1",
        objectResourceType: "tasks",
        updatedAt: 1,
      },
    ];
    await t.mutation(applySync, snapshot);

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_default",
      permission: "tasks:create",
      resourceType: "tasks",
      resourceId: "task_1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_denied");
  });

  test("role and user denies both win globally", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, accessCatalogSnapshot());
    await t.mutation(applySync, acmeOrgSnapshot());

    const reportDecision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      scopeId: "scope_acme",
      permission: "reports.export",
    });
    expect(reportDecision.allowed).toBe(false);
    expect(reportDecision.reasonCode).toBe("permission_denied");
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

// §0b wildcard-role model end-to-end through the authorize entrypoint.
describe("authorize — wildcard roles", () => {
  test("catalog owner_only classification is enforced end to end", async () => {
    const t = convexTest(schema, modules);
    const snapshot = wildcardSnapshot();
    Object.assign(snapshot.entities.permissions[0]!, { classification: "owner_only" });
    await t.mutation(applySync, snapshot);

    const admin = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_admin`,
      scopeId: "scope_default",
      permission: "app.loans:read",
    });
    const owner = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      scopeId: "scope_default",
      permission: "app.loans:read",
    });

    expect(admin.allowed).toBe(false);
    expect(owner.allowed).toBe(true);
  });

  test("owner is allowed for a permission with no role_permission row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      scopeId: "scope_default",
      // owner has NO role_permission row for this catalog permission.
      permission: "app.loans:read",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.principalId).toBe("p_owner");
  });

  test("admin default is allowed for an arbitrary permission with no role row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_admin`,
      scopeId: "scope_default",
      permission: "app.loans:read",
    });
    expect(decision.allowed).toBe(true);
  });

  test("admin default with a deny-only role row is denied that permission", async () => {
    const t = convexTest(schema, modules);
    const snapshot = wildcardSnapshot();
    // A deny-only role_permission row does NOT narrow Admin (canonical
    // isAdminNarrowed): the role keeps wildcard "default" AND carries the deny.
    // The deny must short-circuit before the Admin default-allow.
    snapshot.entities.rolePermissions.push({
      roleId: "role_admin",
      permissionId: "perm_loans_read",
      accessScopeId: "scope_default",
      effect: "deny",
      updatedAt: 1,
    });
    await t.mutation(applySync, snapshot);

    const denied = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_admin`,
      scopeId: "scope_default",
      permission: "app.loans:read",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("permission_denied");

    // A different permission with no deny row stays allowed by the wildcard.
    const allowed = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_admin`,
      scopeId: "scope_default",
      permission: "app.docs:read",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("admin default is fenced from each owner-only lever", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());

    for (const lever of ["system.app:delete", "system.ownership:transfer"]) {
      const decision = await t.query(authorize, {
        tokenIdentifier: `${ISSUER}|user_admin`,
        scopeId: "scope_default",
        permission: lever,
      });
      expect(decision.allowed, lever).toBe(false);
      expect(decision.reasonCode, lever).toBe("permission_denied");
    }

    // The two `manage`-levers fence concrete CRUD verbs on their resourceType
    // even though neither has a deny row — proving the superset (not
    // literal-key) match. The seeded catalog rows are system.billing:update
    // and system.access.owner:delete.
    for (const lever of ["system.billing:update", "system.access.owner:delete"]) {
      const decision = await t.query(authorize, {
        tokenIdentifier: `${ISSUER}|user_admin`,
        scopeId: "scope_default",
        permission: lever,
      });
      expect(decision.allowed, lever).toBe(false);
      expect(decision.reasonCode, lever).toBe("permission_denied");
    }
  });

  test("narrowed admin (wildcard none) falls back to enumerated rows", async () => {
    const t = convexTest(schema, modules);
    const snapshot = wildcardSnapshot();
    const adminRole = snapshot.entities.roles.find((role) => role.roleId === "role_admin")!;
    adminRole.wildcard = "none";
    await t.mutation(applySync, snapshot);

    // No role_permission row for app.loans:read → narrowed admin denied.
    const denied = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_admin`,
      scopeId: "scope_default",
      permission: "app.loans:read",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("permission_denied");
  });

  test("an org-specific Admin allow-list removes wildcard authority in that org", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());
    await t.mutation(applySync, {
      type: "access.projection.snapshot",
      schemaVersion: 2,
      eventId: "evt_org_admin_override",
      sourceVersion: 2,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_org",
        name: "Acme",
        kind: "org",
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 2,
      },
      entities: {
        ...emptyEntities(),
        principals: [
          {
            principalId: "p_org_admin",
            type: "user",
            herculesAuthUserId: "user_admin",
            status: "active",
            joinedAt: 2,
            updatedAt: 2,
          },
        ],
        rolePermissions: [
          {
            roleId: "role_admin",
            permissionId: "perm_docs_read",
            accessScopeId: "scope_org",
            effect: "allow",
            updatedAt: 2,
          },
        ],
        grants: [
          {
            grantId: "grant_org_admin",
            subjectPrincipalId: "p_org_admin",
            relationKind: "role",
            roleId: "role_admin",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_org",
            updatedAt: 2,
          },
        ],
      },
    });

    await expect(
      t.query(authorize, {
        tokenIdentifier: `${ISSUER}|user_admin`,
        scopeId: "scope_org",
        permission: "app.docs:read",
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.query(authorize, {
        tokenIdentifier: `${ISSUER}|user_admin`,
        scopeId: "scope_org",
        permission: "app.loans:read",
      }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "permission_denied" });
  });

  test("manage role row expands to every canonical CRUD verb, not custom verbs", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());

    for (const action of ["read", "create", "update", "delete", "list"]) {
      const decision = await t.query(authorize, {
        tokenIdentifier: `${ISSUER}|user_member`,
        scopeId: "scope_default",
        permission: `app.docs:${action}`,
      });
      expect(decision.allowed, action).toBe(true);
    }
    const custom = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_member`,
      scopeId: "scope_default",
      permission: "app.docs:approve",
    });
    expect(custom.allowed).toBe(false);
    expect(custom.reasonCode).toBe("permission_denied");
  });

  test("a requested permission whose catalog action is manage is rejected", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, wildcardSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_member`,
      scopeId: "scope_default",
      // app.docs:manage is the catalog manage row backing the member grant.
      permission: "app.docs:manage",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("invalid_request");
  });

  // NOTE: the v2-era "reject a per-instance wildcard-role grant at ingest" tests
  // were removed. v3 does not reject binding a wildcard role to a resource at the
  // INGEST layer; instead effective.ts (collectResourceRoleEntries) fails closed
  // at EVALUATION — only tenant, effective-wildcard-"none" roles expand onto a
  // resource, so a system/iam Owner/Admin binding confers nothing on the
  // instance. That fail-closed gate is exercised by parity-ingest.test.ts.
});

// A grant row as the producer projects it for a resource share — IDENTICAL in
// shape whether it originated from an immediate resource grant or from an
// accepted resource invitation. Both flows resolve to one principal-subject,
// resource-object, direct_permission grant carrying (objectResourceType,
// objectId, permissionId, effect). The component only ever sees this projected
// row, so the evaluator must yield the same decision for both origins; the
// parity tests below drive the SAME builder for an "immediate" and an
// "invitation-accepted" grant and assert identical allow/deny.
type ResourceShareGrant = {
  grantId: string;
  effect: "allow" | "deny";
  objectId: string;
  // Optional so a malformed grant (missing resourceType) can be modeled.
  objectResourceType?: string;
};

// Default scope: a single `reports.read` catalog permission, an enumerated
// Viewer role (wildcard "none") that confers NOTHING by itself, alice holding
// Viewer at the scope, and a set of resource grants under test. With no
// resource grant, alice cannot read any report — so any allow below is
// attributable solely to the resource grant being evaluated.
function resourceShareSnapshot(grants: ResourceShareGrant[]): Snapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_resource_share",
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

function readReport(
  t: ReturnType<typeof convexTest>,
  resourceId: string,
  resourceType = "reports",
) {
  return t.query(authorize, {
    tokenIdentifier: `${ISSUER}|user_alice`,
    scopeId: "scope_default",
    permission: "reports.read",
    resourceType,
    resourceId,
  });
}

// An accepted RESOURCE INVITATION's grant and an equivalent IMMEDIATE resource
// grant project to the SAME row, so the evaluator must decide both identically.
// Each case drives the identical grant shape under two grantIds standing in for
// the two origins and asserts byte-identical decisions.
describe("authorize — resource invitation / immediate grant parity", () => {
  test("ordinary resource share allow is identical for both origins", async () => {
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareSnapshot([
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
      resourceShareSnapshot([
        {
          grantId: "grant_invitation",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );

    const fromImmediate = await readReport(immediate, "report_1");
    const fromInvitation = await readReport(invitation, "report_1");
    expect(fromImmediate.allowed).toBe(true);
    expect(fromInvitation.allowed).toBe(true);
    expect(fromInvitation.allowed).toBe(fromImmediate.allowed);
    expect(fromInvitation.reasonCode).toBe(fromImmediate.reasonCode);

    // And neither grant leaks onto a different instance.
    expect((await readReport(immediate, "report_2")).allowed).toBe(false);
    expect((await readReport(invitation, "report_2")).allowed).toBe(false);
  });

  test("an inherited deny overrides the resource share identically for both origins", async () => {
    // A scope-wide (all-instances "*") deny is the inherited/parent-level deny;
    // it must override the instance allow for both origins (deny-overrides).
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareSnapshot([
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
      resourceShareSnapshot([
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

    const fromImmediate = await readReport(immediate, "report_1");
    const fromInvitation = await readReport(invitation, "report_1");
    expect(fromImmediate.allowed).toBe(false);
    expect(fromImmediate.reasonCode).toBe("permission_denied");
    expect(fromInvitation.allowed).toBe(fromImmediate.allowed);
    expect(fromInvitation.reasonCode).toBe(fromImmediate.reasonCode);
  });

  test("a malformed-resourceType grant confers nothing identically for both origins", async () => {
    // objectResourceType missing => the binding lands with resourceId set but
    // resourceType undefined, which the v3 evaluator's indexed
    // (resourceType, resourceId) lookup never matches, so it confers nothing
    // (fail closed). A fail-open fallback to the permission's own resourceType
    // would silently allow here. Same outcome for both origins.
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareSnapshot([
        { grantId: "grant_immediate", effect: "allow", objectId: "report_1" },
      ]),
    );
    const invitation = convexTest(schema, modules);
    await invitation.mutation(
      applySync,
      resourceShareSnapshot([
        { grantId: "grant_invitation", effect: "allow", objectId: "report_1" },
      ]),
    );

    const fromImmediate = await readReport(immediate, "report_1");
    const fromInvitation = await readReport(invitation, "report_1");
    expect(fromImmediate.allowed).toBe(false);
    expect(fromInvitation.allowed).toBe(fromImmediate.allowed);
    expect(fromInvitation.reasonCode).toBe(fromImmediate.reasonCode);
  });
});

// Fail-closed guarantees on the resource-share path, independent of origin.
describe("authorize — resource grant fail-closed", () => {
  test("an instance allow plus an instance deny on the same object denies", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      resourceShareSnapshot([
        {
          grantId: "grant_allow",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
        {
          grantId: "grant_deny",
          effect: "deny",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );

    const decision = await readReport(t, "report_1");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_denied");
    expect(decision.explicitDeny).toBe(true);
  });

  test("a grant whose resourceType does not match the request confers nothing", async () => {
    const t = convexTest(schema, modules);
    // Grant is on resourceType "folders" but the request targets "reports".
    // The binding ingests, but the request's indexed lookup keys on
    // (resourceType="reports", ...) so the "folders" binding is never matched.
    await t.mutation(
      applySync,
      resourceShareSnapshot([
        {
          grantId: "grant_foreign",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "folders",
        },
      ]),
    );

    const decision = await readReport(t, "report_1");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_denied");
  });

  test("a malformed (missing-resourceType) grant never confers the permission", async () => {
    const malformed = convexTest(schema, modules);
    await malformed.mutation(
      applySync,
      resourceShareSnapshot([
        { grantId: "grant_malformed", effect: "allow", objectId: "report_1" },
      ]),
    );
    const malformedDecision = await readReport(malformed, "report_1");
    expect(malformedDecision.allowed).toBe(false);

    // Positive control: the SAME grant shape with a well-formed resourceType
    // DOES confer the permission. The only difference between this and the
    // malformed grant above is objectResourceType, so the denial there is
    // attributable solely to the malformed type — not a vacuous setup.
    const wellFormed = convexTest(schema, modules);
    await wellFormed.mutation(
      applySync,
      resourceShareSnapshot([
        {
          grantId: "grant_well_formed",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );
    const allowed = await readReport(wellFormed, "report_1");
    expect(allowed.allowed).toBe(true);
  });
});

describe("schema gating", () => {
  test("rejects a v1 payload at the mutation validator", async () => {
    const t = convexTest(schema, modules);
    const v1 = { ...wildcardSnapshot(), schemaVersion: 1 };
    await expect(t.mutation(applySync, v1 as never)).rejects.toThrow();
  });

  // NOTE: the v2-era "rejects a role row missing wildcard" test was removed.
  // v3 roles no longer carry a per-role `wildcard` wire field — a catalog role
  // carries an intrinsic `baseWildcard` and the EFFECTIVE wildcard is derived
  // per scope. The v3 payload validator (zod, applySync) rejects a role row
  // missing baseWildcard with invalid_payload; that gating is covered by the
  // projection-protocol parse tests.
});

// A default-scope snapshot exercising all three wildcard modes: Owner
// (immutable), Admin (default, fenced), and an enumerated Member with a
// `manage` role row. Catalog seeds the lever resourceTypes so the Admin fence
// can be exercised against concrete-verb requests.
function wildcardSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
    eventId: "evt_wildcard",
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
          principalId: "p_owner",
          type: "user",
          herculesAuthUserId: "user_owner",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
        {
          principalId: "p_admin",
          type: "user",
          herculesAuthUserId: "user_admin",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
        {
          principalId: "p_member",
          type: "user",
          herculesAuthUserId: "user_member",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
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
          roleId: "role_admin",
          accessScopeId: "scope_default",
          key: "admin",
          kind: "system",
          name: "Admin",
          wildcard: "default",
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
      permissions: [
        {
          permissionId: "perm_loans_read",
          accessScopeId: "scope_default",
          key: "app.loans:read",
          resourceType: "app.loans",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
        // A custom (non-canonical) verb on app.loans so the per-instance
        // wildcard-role test can prove the `*` entry covers ANY verb.
        {
          permissionId: "perm_loans_approve",
          accessScopeId: "scope_default",
          key: "app.loans:approve",
          resourceType: "app.loans",
          action: "approve",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_app_delete",
          accessScopeId: "scope_default",
          key: "system.app:delete",
          resourceType: "system.app",
          action: "delete",
          tenantAssignable: false,
          updatedAt: 1,
        },
        {
          permissionId: "perm_ownership_transfer",
          accessScopeId: "scope_default",
          key: "system.ownership:transfer",
          resourceType: "system.ownership",
          action: "transfer",
          tenantAssignable: false,
          updatedAt: 1,
        },
        {
          permissionId: "perm_billing_update",
          accessScopeId: "scope_default",
          key: "system.billing:update",
          resourceType: "system.billing",
          action: "update",
          tenantAssignable: false,
          updatedAt: 1,
        },
        {
          permissionId: "perm_access_owner_delete",
          accessScopeId: "scope_default",
          key: "system.access.owner:delete",
          resourceType: "system.access.owner",
          action: "delete",
          tenantAssignable: false,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_manage",
          accessScopeId: "scope_default",
          key: "app.docs:manage",
          resourceType: "app.docs",
          action: "manage",
          tenantAssignable: true,
          updatedAt: 1,
        },
        // Concrete CRUD catalog rows on app.docs so the member's `manage`
        // role row can be requested via individual verbs.
        {
          permissionId: "perm_docs_read",
          accessScopeId: "scope_default",
          key: "app.docs:read",
          resourceType: "app.docs",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_create",
          accessScopeId: "scope_default",
          key: "app.docs:create",
          resourceType: "app.docs",
          action: "create",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_update",
          accessScopeId: "scope_default",
          key: "app.docs:update",
          resourceType: "app.docs",
          action: "update",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_delete",
          accessScopeId: "scope_default",
          key: "app.docs:delete",
          resourceType: "app.docs",
          action: "delete",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_list",
          accessScopeId: "scope_default",
          key: "app.docs:list",
          resourceType: "app.docs",
          action: "list",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_approve",
          accessScopeId: "scope_default",
          key: "app.docs:approve",
          resourceType: "app.docs",
          action: "approve",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [
        // Member is enumerated with a single `manage` row on app.docs.
        {
          roleId: "role_member",
          permissionId: "perm_docs_manage",
          accessScopeId: "scope_default",
          effect: "allow",
          updatedAt: 1,
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
          grantId: "grant_admin",
          subjectPrincipalId: "p_admin",
          relationKind: "role",
          roleId: "role_admin",
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

function accessCatalogSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
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

function acmeOrgSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 2,
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
