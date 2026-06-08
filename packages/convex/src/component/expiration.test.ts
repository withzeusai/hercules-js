import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  emptyAccessProjectionEntities,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
} from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);
const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const authorize = makeFunctionReference<"query">("component/checks:authorize");

const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();
const ISSUER = "https://auth.example.com";

afterEach(() => {
  vi.useRealTimers();
});

describe("grant expiration", () => {
  test("expires a projected grant without an unrelated write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshotWithGrant(NOW + 1_000, 1));
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: true,
    });

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readGrant(t)).resolves.toBeNull();
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });
  });

  test("a stale timer cannot remove an extended grant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshotWithGrant(NOW + 1_000, 1));
    await t.mutation(applySync, grantEvent(NOW + 2_000, 2));

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readGrant(t)).resolves.toMatchObject({
      grantId: "grant_tasks_create",
      expiresAt: NOW + 2_000,
      updatedAt: 2,
    });
    await expect(authorizeTasksCreate(t)).resolves.toMatchObject({
      allowed: true,
    });

    vi.advanceTimersByTime(1_000);
    await t.finishInProgressScheduledFunctions();

    await expect(readGrant(t)).resolves.toBeNull();
  });

  test("omits grants that are already expired in snapshots and events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const snapshotTest = convexTest(schema, modules);
    await snapshotTest.mutation(
      applySync,
      snapshotWithGrant(NOW - 1, 1),
    );
    await expect(readGrant(snapshotTest)).resolves.toBeNull();
    await expect(authorizeTasksCreate(snapshotTest)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });

    const eventTest = convexTest(schema, modules);
    await eventTest.mutation(applySync, snapshotWithoutGrant());
    await eventTest.mutation(applySync, grantEvent(NOW - 1, 2));
    await expect(readGrant(eventTest)).resolves.toBeNull();
    await expect(authorizeTasksCreate(eventTest)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "permission_denied",
    });
  });
});

function snapshotWithGrant(
  expiresAt: number,
  updatedAt: number,
): AccessProjectionSnapshot {
  const snapshot = snapshotWithoutGrant();
  snapshot.scopes[0]!.entities.grants = [
    taskGrant(expiresAt, updatedAt),
  ];
  return snapshot;
}

function snapshotWithoutGrant(): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 3,
    eventId: "snapshot_1",
    sourceVersion: 1,
    mode: "initialize",
    expectedIssuer: ISSUER,
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
        entities: {
          ...emptyAccessProjectionEntities(),
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
          permissions: [
            {
              accessScopeId: "scope_default",
              permissionId: "permission_tasks_create",
              key: "tasks:create",
              resourceType: "tasks",
              action: "create",
              classification: "delegable",
              tenantAssignable: true,
              updatedAt: 1,
            },
          ],
        },
      },
    ],
  };
}

function grantEvent(
  expiresAt: number,
  updatedAt: number,
): AccessProjectionEvent {
  return {
    type: "access.projection.event",
    schemaVersion: 3,
    eventId: `event_${updatedAt}`,
    sourceVersion: 2,
    scopes: [
      {
        scope: {
          ...snapshotWithoutGrant().scopes[0]!.scope,
          updatedAt,
        },
        changes: [
          {
            entityType: "grant",
            entityId: "grant_tasks_create",
            operation: "upsert",
          },
        ],
        entities: {
          ...emptyAccessProjectionEntities(),
          grants: [taskGrant(expiresAt, updatedAt)],
        },
      },
    ],
  };
}

function taskGrant(expiresAt: number, updatedAt: number) {
  return {
    grantId: "grant_tasks_create",
    subjectPrincipalId: "principal_alice",
    relationKind: "direct_permission" as const,
    permissionId: "permission_tasks_create",
    effect: "allow" as const,
    objectType: "scope" as const,
    objectId: "scope_default",
    expiresAt,
    updatedAt,
  };
}

async function authorizeTasksCreate(
  t: ReturnType<typeof convexTest>,
) {
  return await t.query(authorize, {
    tokenIdentifier: `${ISSUER}|user_alice`,
    scopeId: "scope_default",
    permission: "tasks:create",
  });
}

async function readGrant(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("grants")
      .withIndex("by_grant_id", (query) =>
        query.eq("grantId", "grant_tasks_create"),
      )
      .unique();
  });
}
