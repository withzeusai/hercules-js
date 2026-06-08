import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  emptyAccessProjectionEntities,
  type AccessProjectionEvent,
  type AccessProjectionSnapshot,
  type AccessProjectionSnapshotScope,
} from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);
const applySync = makeFunctionReference<"mutation">("component/sync:applySync");

const defaultScope = {
  accessScopeId: "scope_default",
  name: "Default",
  kind: "default" as const,
  status: "active" as const,
  accountEntryMode: "open" as const,
  defaultRoleId: "role_member",
  updatedAt: 1,
};

const orgScope = {
  ...defaultScope,
  accessScopeId: "scope_org",
  name: "Acme",
  kind: "org" as const,
};

const otherOrgScope = {
  ...orgScope,
  accessScopeId: "scope_other_org",
  name: "Other Org",
};

function scope(
  metadata = defaultScope,
  entities = emptyAccessProjectionEntities(),
): AccessProjectionSnapshotScope {
  return { scope: metadata, entities };
}

function snapshot(
  overrides: Partial<
    Omit<AccessProjectionSnapshot, "type" | "schemaVersion">
  > = {},
): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 3,
    eventId: "snapshot_1",
    mode: "initialize",
    sourceVersion: 1,
    expectedIssuer: "https://auth.example.com",
    scopes: [scope()],
    ...overrides,
  };
}

function event(
  overrides: Partial<
    Omit<AccessProjectionEvent, "type" | "schemaVersion">
  > = {},
): AccessProjectionEvent {
  return {
    type: "access.projection.event",
    schemaVersion: 3,
    eventId: "event_2",
    sourceVersion: 2,
    scopes: [
      {
        scope: defaultScope,
        changes: [],
        entities: emptyAccessProjectionEntities(),
      },
    ],
    ...overrides,
  };
}

describe("applySync v3 state machine", () => {
  test("initializes every projected scope atomically", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(
      applySync,
      snapshot({
        scopes: [
          scope(defaultScope, {
            ...emptyAccessProjectionEntities(),
            principals: [
              {
                principalId: "principal_default",
                type: "user",
                herculesAuthUserId: "user_1",
                status: "active",
                joinedAt: 1,
                updatedAt: 1,
              },
            ],
          }),
          scope(orgScope, {
            ...emptyAccessProjectionEntities(),
            principals: [
              {
                principalId: "principal_org",
                type: "user",
                herculesAuthUserId: "user_1",
                status: "active",
                joinedAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        ],
      }),
    );

    expect(result).toEqual({
      ok: true,
      status: "applied",
      acknowledgedVersion: 1,
    });
    await t.run(async (ctx) => {
      expect(
        (await ctx.db.query("scopes").collect())
          .map((row) => row.accessScopeId)
          .sort(),
      ).toEqual(["scope_default", "scope_org"]);
      expect(
        (await ctx.db.query("principals").collect())
          .map((row) => row.principalId)
          .sort(),
      ).toEqual(["principal_default", "principal_org"]);
    });
  });

  test("returns not_ready for an event before initialization", async () => {
    const t = convexTest(schema, modules);

    await expect(t.mutation(applySync, event())).resolves.toEqual({
      ok: false,
      status: "not_ready",
      currentVersion: 0,
    });
  });

  test("returns default_scope_required when an aggregate has no default scope", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [scope(orgScope)],
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      status: "default_scope_required",
    });
  });

  test("requires reset instead of re-running initialization", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, snapshot());

    await expect(
      t.mutation(
        applySync,
        snapshot({ eventId: "snapshot_2", sourceVersion: 2 }),
      ),
    ).resolves.toEqual({
      ok: false,
      status: "reset_required",
      currentVersion: 1,
    });
  });

  test("reset replaces the entire aggregate mirror", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({
        scopes: [scope(), scope(orgScope)],
      }),
    );

    await expect(
      t.mutation(
        applySync,
        snapshot({
          eventId: "snapshot_2",
          mode: "reset",
          sourceVersion: 2,
          scopes: [scope()],
        }),
      ),
    ).resolves.toEqual({ ok: true, status: "applied", acknowledgedVersion: 2 });

    await t.run(async (ctx) => {
      expect(
        (await ctx.db.query("scopes").collect()).map(
          (row) => row.accessScopeId,
        ),
      ).toEqual(["scope_default"]);
      expect(await ctx.db.query("organizations").collect()).toEqual([]);
    });
  });

  test("same-version reset repairs the mirror without admitting stale events", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({
        eventId: "snapshot_5",
        sourceVersion: 5,
        scopes: [scope(), scope(orgScope)],
      }),
    );

    const repair = snapshot({
      eventId: "repair_5",
      mode: "reset",
      sourceVersion: 5,
      scopes: [scope()],
    });
    await expect(t.mutation(applySync, repair)).resolves.toEqual({
      ok: true,
      status: "applied",
      acknowledgedVersion: 5,
    });
    await expect(t.mutation(applySync, repair)).resolves.toEqual({
      ok: true,
      status: "duplicate",
      acknowledgedVersion: 5,
    });
    await expect(
      t.mutation(
        applySync,
        event({ eventId: "stale_event_5", sourceVersion: 5 }),
      ),
    ).resolves.toEqual({
      ok: false,
      status: "version_gap",
      currentVersion: 5,
      expectedVersion: 6,
      receivedVersion: 5,
    });

    await t.run(async (ctx) => {
      expect(
        (await ctx.db.query("scopes").collect()).map(
          (row) => row.accessScopeId,
        ),
      ).toEqual(["scope_default"]);
      expect(await ctx.db.query("organizations").collect()).toEqual([]);
    });
  });

  test.each([4])(
    "rejects a reset at stale source version %s",
    async (sourceVersion) => {
      const t = convexTest(schema, modules);
      await t.mutation(applySync, snapshot({ sourceVersion: 5 }));

      await expect(
        t.mutation(
          applySync,
          snapshot({
            eventId: `snapshot_${sourceVersion}`,
            mode: "reset",
            sourceVersion,
          }),
        ),
      ).resolves.toEqual({
        ok: false,
        status: "version_gap",
        currentVersion: 5,
        expectedVersion: 6,
        receivedVersion: sourceVersion,
      });
      expect(
        (await t.run((ctx) => ctx.db.query("sync_state").unique()))
          ?.sourceVersion,
      ).toBe(5);
    },
  );

  test("accepts only the exact next event version", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, snapshot({ sourceVersion: 5 }));

    await expect(
      t.mutation(applySync, event({ sourceVersion: 7 })),
    ).resolves.toEqual({
      ok: false,
      status: "version_gap",
      currentVersion: 5,
      expectedVersion: 6,
      receivedVersion: 7,
    });
    await expect(
      t.mutation(
        applySync,
        event({ eventId: "event_stale", sourceVersion: 5 }),
      ),
    ).resolves.toEqual({
      ok: false,
      status: "version_gap",
      currentVersion: 5,
      expectedVersion: 6,
      receivedVersion: 5,
    });
  });

  test("recognizes duplicates by event id, not version alone", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({ eventId: "snapshot_5", sourceVersion: 5 }),
    );

    await expect(
      t.mutation(
        applySync,
        snapshot({ eventId: "snapshot_5", sourceVersion: 5 }),
      ),
    ).resolves.toEqual({
      ok: true,
      status: "duplicate",
      acknowledgedVersion: 5,
    });

    await t.mutation(
      applySync,
      event({ eventId: "event_6", sourceVersion: 6 }),
    );
    await expect(
      t.mutation(applySync, event({ eventId: "event_6", sourceVersion: 6 })),
    ).resolves.toEqual({
      ok: true,
      status: "duplicate",
      acknowledgedVersion: 6,
    });
    await expect(
      t.mutation(applySync, event({ eventId: "event_6", sourceVersion: 7 })),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("validates every change before applying any write", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({
        scopes: [
          scope(defaultScope, {
            ...emptyAccessProjectionEntities(),
            principals: [
              {
                principalId: "principal_existing",
                type: "user",
                herculesAuthUserId: "user_existing",
                status: "active",
                joinedAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        ],
      }),
    );

    const result = await t.mutation(
      applySync,
      event({
        scopes: [
          {
            scope: defaultScope,
            changes: [
              {
                entityType: "principal",
                entityId: "principal_existing",
                operation: "delete",
              },
              {
                entityType: "principal",
                entityId: "principal_missing",
                operation: "upsert",
              },
            ],
            entities: emptyAccessProjectionEntities(),
          },
        ],
      }),
    );

    expect(result).toEqual({ ok: false, status: "invalid_payload" });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) =>
            q.eq("principalId", "principal_existing"),
          )
          .unique(),
      ).not.toBeNull();
      expect((await ctx.db.query("sync_state").unique())?.sourceVersion).toBe(
        1,
      );
    });
  });

  test("rejects an event that deletes an entity through another scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({
        scopes: [
          scope(defaultScope, {
            ...emptyAccessProjectionEntities(),
            principals: [
              {
                principalId: "principal_default",
                type: "user",
                herculesAuthUserId: "user_1",
                status: "active",
                joinedAt: 1,
                updatedAt: 1,
              },
            ],
          }),
          scope(orgScope),
        ],
      }),
    );

    await expect(
      t.mutation(
        applySync,
        event({
          scopes: [
            {
              scope: orgScope,
              changes: [
                {
                  entityType: "principal",
                  entityId: "principal_default",
                  operation: "delete",
                },
              ],
              entities: emptyAccessProjectionEntities(),
            },
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });

    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) =>
            q.eq("principalId", "principal_default"),
          )
          .unique(),
      ).not.toBeNull();
    });
  });

  test("rejects an upsert whose entity scope differs from its event envelope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      snapshot({
        scopes: [
          scope(defaultScope, {
            ...emptyAccessProjectionEntities(),
            roles: [
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
                permissionId: "permission_read",
                accessScopeId: "scope_default",
                key: "reports.read",
                resourceType: "reports",
                action: "read",
                classification: "delegable",
                tenantAssignable: true,
                updatedAt: 1,
              },
            ],
          }),
          scope(orgScope),
        ],
      }),
    );

    await expect(
      t.mutation(
        applySync,
        event({
          scopes: [
            {
              scope: orgScope,
              changes: [
                {
                  entityType: "role_permission",
                  entityId: "role_member:permission_read:allow",
                  operation: "upsert",
                },
              ],
              entities: {
                ...emptyAccessProjectionEntities(),
                rolePermissions: [
                  {
                    roleId: "role_member",
                    permissionId: "permission_read",
                    accessScopeId: "scope_default",
                    effect: "allow",
                    updatedAt: 2,
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("rejects snapshot entities placed in another scope envelope", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [
            scope(defaultScope, {
              ...emptyAccessProjectionEntities(),
              roles: [
                {
                  roleId: "role_org",
                  accessScopeId: "scope_org",
                  key: "editor",
                  kind: "custom",
                  name: "Editor",
                  wildcard: "none",
                  updatedAt: 1,
                },
              ],
            }),
            scope(orgScope),
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("rejects issuer changes without replacing the mirror", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, snapshot());

    await expect(
      t.mutation(
        applySync,
        snapshot({
          eventId: "snapshot_2",
          mode: "reset",
          sourceVersion: 2,
          expectedIssuer: "https://other.example.com",
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "issuer_mismatch" });
    expect(
      (await t.run((ctx) => ctx.db.query("sync_state").unique()))
        ?.sourceVersion,
    ).toBe(1);
  });

  test.each([
    {
      roleId: "role_owner",
      accessScopeId: "scope_default",
      key: "owner",
      kind: "custom" as const,
      name: "Owner",
      wildcard: "none" as const,
      updatedAt: 1,
    },
    {
      roleId: "role_admin",
      accessScopeId: "scope_default",
      key: "admin",
      kind: "system" as const,
      name: "Admin",
      wildcard: "immutable" as const,
      updatedAt: 1,
    },
  ])("rejects malformed $key role rows", async (role) => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [
            scope(defaultScope, {
              ...emptyAccessProjectionEntities(),
              roles: [role],
            }),
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("rejects system roles granted on resources", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [
            scope(defaultScope, {
              ...emptyAccessProjectionEntities(),
              principals: [
                {
                  principalId: "principal_1",
                  type: "user",
                  herculesAuthUserId: "user_1",
                  status: "active",
                  joinedAt: 1,
                  updatedAt: 1,
                },
              ],
              roles: [
                {
                  roleId: "role_admin",
                  accessScopeId: "scope_default",
                  key: "admin",
                  kind: "system",
                  name: "Admin",
                  wildcard: "default",
                  updatedAt: 1,
                },
              ],
              grants: [
                {
                  grantId: "grant_1",
                  subjectPrincipalId: "principal_1",
                  relationKind: "role",
                  roleId: "role_admin",
                  effect: "allow",
                  objectType: "resource",
                  objectId: "project_1",
                  objectResourceType: "projects",
                  updatedAt: 1,
                },
              ],
            }),
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("rejects custom roles granted across scopes", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [
            scope(),
            scope(orgScope, {
              ...emptyAccessProjectionEntities(),
              roles: [
                {
                  roleId: "role_org",
                  accessScopeId: "scope_org",
                  key: "editor",
                  kind: "custom",
                  name: "Editor",
                  wildcard: "none",
                  updatedAt: 1,
                },
              ],
            }),
            scope(otherOrgScope, {
              ...emptyAccessProjectionEntities(),
              principals: [
                {
                  principalId: "principal_other",
                  type: "user",
                  herculesAuthUserId: "user_other",
                  status: "active",
                  joinedAt: 1,
                  updatedAt: 1,
                },
              ],
              grants: [
                {
                  grantId: "grant_cross_scope",
                  subjectPrincipalId: "principal_other",
                  relationKind: "role",
                  roleId: "role_org",
                  effect: "allow",
                  objectType: "scope",
                  objectId: "scope_other_org",
                  updatedAt: 1,
                },
              ],
            }),
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });

  test("rejects direct resource grants with a mismatched permission type", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(
        applySync,
        snapshot({
          scopes: [
            scope(defaultScope, {
              ...emptyAccessProjectionEntities(),
              principals: [
                {
                  principalId: "principal_1",
                  type: "user",
                  herculesAuthUserId: "user_1",
                  status: "active",
                  joinedAt: 1,
                  updatedAt: 1,
                },
              ],
              permissions: [
                {
                  permissionId: "permission_1",
                  accessScopeId: "scope_default",
                  key: "reports.read",
                  resourceType: "reports",
                  action: "read",
                  classification: "delegable",
                  tenantAssignable: true,
                  updatedAt: 1,
                },
              ],
              grants: [
                {
                  grantId: "grant_1",
                  subjectPrincipalId: "principal_1",
                  relationKind: "direct_permission",
                  permissionId: "permission_1",
                  effect: "allow",
                  objectType: "resource",
                  objectId: "folder_1",
                  objectResourceType: "folders",
                  updatedAt: 1,
                },
              ],
            }),
          ],
        }),
      ),
    ).resolves.toEqual({ ok: false, status: "invalid_payload" });
  });
});
