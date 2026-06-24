import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AccessProjectionEvent, AccessProjectionSnapshot } from "../shared/sync";
import snapshotFixture from "../shared/__fixtures__/projection-v4/snapshot.json";
import schema from "./schema";

import { componentModules as modules } from "../../test/component-modules";
const applySync = makeFunctionReference<"mutation">("sync:applySync");
const authorize = makeFunctionReference<"query">("checks:authorize");

const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();
const ISSUER = "https://auth.example.com";

// A time-bound permission_binding is the v4 successor of the old expiring
// direct-permission grant. sync.ts schedules an exact-identity deletion at
// expiresAt; effective.ts also fails closed on the timestamp if the schedule is
// delayed. These tests drive the v4 wire shape (top-level catalog + users,
// per-scope permissionBindings) end to end.

afterEach(() => {
  vi.useRealTimers();
});

describe("permission binding expiration", () => {
  test("expires a projected binding without an unrelated write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshotWithBinding(NOW + 1_000, 1));
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: true,
    });

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readBinding(t)).resolves.toBeNull();
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });
  });

  test("a stale timer cannot remove an extended binding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshotWithBinding(NOW + 1_000, 1));
    await t.mutation(applySync, bindingEvent(NOW + 2_000, 2));

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readBinding(t)).resolves.toMatchObject({
      bindingId: "pb_tasks_create",
      expiresAt: NOW + 2_000,
      updatedAt: 2,
    });
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: true,
    });

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readBinding(t)).resolves.toBeNull();
  });

  test("omits bindings that are already expired in snapshots and events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const snapshotTest = convexTest(schema, modules);
    await snapshotTest.mutation(applySync, snapshotWithBinding(NOW - 1, 1));
    await expect(readBinding(snapshotTest)).resolves.toBeNull();
    await expect(authorizeTasksCreate(snapshotTest)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });

    const eventTest = convexTest(schema, modules);
    await eventTest.mutation(applySync, snapshotWithoutBinding());
    await eventTest.mutation(applySync, bindingEvent(NOW - 1, 2));
    await expect(readBinding(eventTest)).resolves.toBeNull();
    await expect(authorizeTasksCreate(eventTest)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });
  });
});

function snapshotWithBinding(expiresAt: number, updatedAt: number): AccessProjectionSnapshot {
  const snapshot = snapshotWithoutBinding();
  snapshot.scopes[0]!.permissionBindings = [taskBinding(expiresAt, updatedAt)];
  return snapshot;
}

function snapshotWithoutBinding(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 4,
    eventId: "snapshot_1",
    sourceVersion: 1,
    mode: "initialize",
    expectedIssuer: ISSUER,
    catalog: {
      roles: [
        {
          roleId: "role_member",
          key: "member",
          source: "system",
          name: "Member",
          description: null,
          baseWildcard: "none",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "permission_tasks_create",
          key: "tasks:create",
          resourceType: "tasks",
          action: "create",
          classification: "delegable",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [],
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
          kind: "default",
          status: "active",
          accessMode: "open",
          defaultRoleId: "role_member",
          updatedAt: 1,
        },
        principals: [
          {
            principalId: "principal_alice",
            type: "user",
            herculesAuthUserId: "user_alice",
            status: "active",
            joinedAt: 1,
            updatedAt: 1,
          },
        ],
        principalMemberships: [],
        roles: [],
        rolePermissionOverrides: [],
        roleBindings: [],
        permissionBindings: [],
      },
    ],
  };
}

function bindingEvent(expiresAt: number, updatedAt: number): AccessProjectionEvent {
  return {
    type: "access.projection.event",
    schemaVersion: 4,
    eventId: `event_${updatedAt}`,
    sourceVersion: 2,
    scopes: [
      {
        accessScopeId: "scope_default",
        changes: [
          {
            entityType: "permission_binding",
            bindingId: "pb_tasks_create",
            operation: "upsert",
          },
        ],
        principals: [],
        principalMemberships: [],
        roles: [],
        rolePermissionOverrides: [],
        roleBindings: [],
        permissionBindings: [taskBinding(expiresAt, updatedAt)],
      },
    ],
  };
}

function taskBinding(expiresAt: number, updatedAt: number) {
  return {
    bindingId: "pb_tasks_create",
    subjectPrincipalId: "principal_alice",
    permissionId: "permission_tasks_create",
    effect: "allow" as const,
    accessScopeId: "scope_default",
    appliesTo: "self" as const,
    expiresAt,
    updatedAt,
  };
}

async function authorizeTasksCreate(t: TestConvex<typeof schema>) {
  return await t.query(authorize, {
    tokenIdentifier: `${ISSUER}|user_alice`,
    tenantId: "scope_default",
    permission: "tasks:create",
  });
}

async function readBinding(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("permission_bindings")
      .withIndex("by_binding_id", (query) => query.eq("bindingId", "pb_tasks_create"))
      .unique();
  });
}

describe("projection row source versions", () => {
  test("a snapshot stamps every mirrored table with its source version", async () => {
    const t = convexTest(schema, modules);
    const snapshot = snapshotWithGroupMembership();

    await expect(t.mutation(applySync, snapshot)).resolves.toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 7,
    });

    const rowsByTable = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      scopes: await ctx.db.query("scopes").collect(),
      organizations: await ctx.db.query("organizations").collect(),
      principals: await ctx.db.query("principals").collect(),
      principalMemberships: await ctx.db.query("principal_memberships").collect(),
      roles: await ctx.db.query("roles").collect(),
      permissions: await ctx.db.query("permissions").collect(),
      rolePermissions: await ctx.db.query("role_permissions").collect(),
      rolePermissionOverrides: await ctx.db.query("role_permission_overrides").collect(),
      roleBindings: await ctx.db.query("role_bindings").collect(),
      permissionBindings: await ctx.db.query("permission_bindings").collect(),
    }));

    for (const [table, rows] of Object.entries(rowsByTable)) {
      expect(rows, `${table} should contain fixture rows`).not.toHaveLength(0);
      expect(
        rows.every((row) => row.sourceVersion === snapshot.sourceVersion),
        `${table} rows should be stamped with the snapshot source version`,
      ).toBe(true);
    }
  });

  test("an event advances touched and derived rows without rewriting untouched rows", async () => {
    const t = convexTest(schema, modules);
    const snapshot = snapshotWithGroup();
    await t.mutation(applySync, snapshot);

    const orgScope = snapshot.scopes.find((entry) => entry.scope.kind === "org")!.scope;
    const event: AccessProjectionEvent = {
      type: "access.projection.event",
      schemaVersion: 4,
      eventId: "evt_source_version_0008",
      sourceVersion: 8,
      scopes: [
        {
          accessScopeId: "as_default",
          changes: [
            {
              entityType: "principal_membership",
              groupPrincipalId: "pr_default_engineering",
              memberPrincipalId: "pr_default_bob",
              operation: "upsert",
            },
          ],
          principals: [],
          principalMemberships: [
            {
              groupPrincipalId: "pr_default_engineering",
              memberPrincipalId: "pr_default_bob",
              updatedAt: 1780444800000,
            },
          ],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [],
          permissionBindings: [],
        },
        {
          accessScopeId: orgScope.accessScopeId,
          scope: {
            ...orgScope,
            name: "Acme Updated",
            updatedAt: 1780444800000,
          },
          changes: [
            {
              entityType: "scope",
              accessScopeId: orgScope.accessScopeId,
              operation: "upsert",
            },
          ],
          principals: [],
          principalMemberships: [],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [],
          permissionBindings: [],
        },
      ],
    };

    await expect(t.mutation(applySync, event)).resolves.toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 8,
    });

    const rows = await t.run(async (ctx) => ({
      group: await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_engineering"))
        .unique(),
      untouchedUser: await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_bob"))
        .unique(),
      membership: await ctx.db
        .query("principal_memberships")
        .withIndex("by_group_member", (q) =>
          q
            .eq("accessScopeId", "as_default")
            .eq("groupPrincipalId", "pr_default_engineering")
            .eq("memberPrincipalId", "pr_default_bob"),
        )
        .unique(),
      orgScope: await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", orgScope.accessScopeId))
        .unique(),
      organization: await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", orgScope.accessScopeId))
        .unique(),
      syncState: await ctx.db.query("sync_state").unique(),
    }));

    expect(rows.group).toMatchObject({ memberCount: 1, sourceVersion: 8 });
    expect(rows.membership).toMatchObject({ sourceVersion: 8 });
    expect(rows.untouchedUser).toMatchObject({ sourceVersion: 7 });
    expect(rows.orgScope).toMatchObject({ name: "Acme Updated", sourceVersion: 8 });
    expect(rows.organization).toMatchObject({ name: "Acme Updated", sourceVersion: 8 });
    expect(rows.syncState).toMatchObject({ sourceVersion: 8 });
  });

  test("a repeated user profile advances its source version", async () => {
    const t = convexTest(schema, modules);
    const snapshot = snapshotWithGroup();
    await t.mutation(applySync, snapshot);

    const user = snapshot.users[0]!;
    const event: AccessProjectionEvent = {
      type: "access.projection.event",
      schemaVersion: 4,
      eventId: "evt_user_source_version_0008",
      sourceVersion: 8,
      users: {
        changes: [
          {
            entityType: "user",
            herculesAuthUserId: user.herculesAuthUserId,
            operation: "upsert",
          },
        ],
        users: [user],
      },
    };

    await expect(t.mutation(applySync, event)).resolves.toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 8,
    });

    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("users")
          .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", user.herculesAuthUserId))
          .unique(),
      ),
    ).resolves.toMatchObject({
      name: user.name,
      updatedAt: user.updatedAt,
      sourceVersion: 8,
    });
  });
});

describe("projection scope deletion", () => {
  test("removes every row owned by the deleted scope", async () => {
    const t = convexTest(schema, modules);
    const snapshot = structuredClone(snapshotFixture) as AccessProjectionSnapshot;
    const org = snapshot.scopes.find((entry) => entry.scope.accessScopeId === "as_org1")!;

    org.principals.push({
      principalId: "pr_org1_engineering",
      type: "group",
      name: "Engineering",
      status: "active",
      joinedAt: 1767225600000,
      updatedAt: 1767225600000,
    });
    org.principalMemberships.push({
      groupPrincipalId: "pr_org1_engineering",
      memberPrincipalId: "pr_org1_alice",
      updatedAt: 1767225600000,
    });
    org.permissionBindings.push({
      bindingId: "pb_org1_alice_docs_read",
      subjectPrincipalId: "pr_org1_alice",
      permissionId: "perm_docs_read",
      effect: "allow",
      accessScopeId: "as_org1",
      appliesTo: "self",
      updatedAt: 1767225600000,
    });

    await expect(t.mutation(applySync, snapshot)).resolves.toMatchObject({
      ok: true,
      status: "applied",
    });

    const event: AccessProjectionEvent = {
      type: "access.projection.event",
      schemaVersion: 4,
      eventId: "evt_delete_scope_0008",
      sourceVersion: 8,
      scopes: [
        {
          accessScopeId: "as_org1",
          changes: [
            {
              entityType: "scope",
              accessScopeId: "as_org1",
              operation: "delete",
            },
          ],
          principals: [],
          principalMemberships: [],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [],
          permissionBindings: [],
        },
      ],
    };

    await expect(t.mutation(applySync, event)).resolves.toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 8,
    });

    const remaining = await t.run(async (ctx) => ({
      scopes: await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      organizations: await ctx.db
        .query("organizations")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      principals: await ctx.db
        .query("principals")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      principalMemberships: await ctx.db
        .query("principal_memberships")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      roles: await ctx.db
        .query("roles")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      rolePermissionOverrides: await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      roleBindings: await ctx.db
        .query("role_bindings")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      permissionBindings: await ctx.db
        .query("permission_bindings")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", "as_org1"))
        .collect(),
      catalogRoles: await ctx.db
        .query("roles")
        .withIndex("by_scope", (q) => q.eq("accessScopeId", undefined))
        .collect(),
    }));

    expect(remaining).toMatchObject({
      scopes: [],
      organizations: [],
      principals: [],
      principalMemberships: [],
      roles: [],
      rolePermissionOverrides: [],
      roleBindings: [],
      permissionBindings: [],
    });
    expect(remaining.catalogRoles).not.toHaveLength(0);
  });
});

function snapshotWithGroup(): AccessProjectionSnapshot {
  const snapshot = structuredClone(snapshotFixture) as AccessProjectionSnapshot;
  snapshot.scopes[0]!.principals.push({
    principalId: "pr_default_engineering",
    type: "group",
    name: "Engineering",
    status: "active",
    joinedAt: 1780358400000,
    updatedAt: 1780358400000,
  });
  return snapshot;
}

function snapshotWithGroupMembership(): AccessProjectionSnapshot {
  const snapshot = snapshotWithGroup();
  snapshot.scopes[0]!.principalMemberships.push({
    groupPrincipalId: "pr_default_engineering",
    memberPrincipalId: "pr_default_bob",
    updatedAt: 1780358400000,
  });
  return snapshot;
}
