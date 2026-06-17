import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AccessProjectionEvent, AccessProjectionSnapshot } from "../shared/sync";
import schema from "./schema";

import { componentModules as modules } from "../../test/component-modules";
const applySync = makeFunctionReference<"mutation">("sync:applySync");
const authorize = makeFunctionReference<"query">("checks:authorize");

const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();
const ISSUER = "https://auth.example.com";

// A time-bound permission_binding is the v3 successor of the old expiring
// direct-permission grant. sync.ts schedules an exact-identity deletion at
// expiresAt; effective.ts also fails closed on the timestamp if the schedule is
// delayed. These tests drive the v3 wire shape (top-level catalog + users,
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
    schemaVersion: 3,
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
          accountEntryMode: "open",
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
    schemaVersion: 3,
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
    expiresAt,
    updatedAt,
  };
}

async function authorizeTasksCreate(t: TestConvex<typeof schema>) {
  return await t.query(authorize, {
    tokenIdentifier: `${ISSUER}|user_alice`,
    scopeId: "scope_default",
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
