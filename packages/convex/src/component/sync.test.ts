import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import type { AccessProjectionEvent, AccessProjectionSnapshot } from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);

const applySync = makeFunctionReference<"mutation">("component/sync:applySync");

const baseScopeMeta = {
  accessScopeId: "scope_default",
  name: "Default",
  kind: "default" as const,
  status: "active" as const,
  accountEntryMode: "open" as const,
  defaultRoleId: "role_member",
  updatedAt: 1,
};

const orgScopeMeta = {
  accessScopeId: "scope_acme",
  name: "Acme",
  kind: "org" as const,
  status: "active" as const,
  accountEntryMode: "open" as const,
  defaultRoleId: "role_member",
  updatedAt: 1,
};

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

function snapshot(overrides: Partial<AccessProjectionSnapshot> = {}): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
    eventId: "evt_seed",
    sourceVersion: 1,
    expectedIssuer: "https://auth.example.com",
    scope: baseScopeMeta,
    entities: emptyEntities(),
    ...overrides,
  };
}

function event(overrides: Partial<AccessProjectionEvent> = {}): AccessProjectionEvent {
  return {
    type: "access.projection.event",
    schemaVersion: 1,
    eventId: "evt_e1",
    sourceVersion: 2,
    scope: baseScopeMeta,
    changes: [],
    entities: emptyEntities(),
    ...overrides,
  };
}

describe("applySync", () => {
  test("applies an initial snapshot and writes singleton + scope rows", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(applySync, snapshot());
    expect(result).toEqual({ ok: true, status: "applied", acknowledgedVersion: 1 });

    await t.run(async (ctx) => {
      const state = await ctx.db.query("sync_state").unique();
      expect(state).not.toBeNull();
      expect(state!.sourceVersion).toBe(1);
      expect(state!.expectedIssuer).toBe("https://auth.example.com");

      const scope = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", "scope_default"))
        .unique();
      expect(scope).not.toBeNull();
      expect(scope!.kind).toBe("default");
    });
  });

  test("snapshot for scope B preserves scope A entities", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      snapshot({
        eventId: "evt_a",
        sourceVersion: 1,
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
        },
      }),
    );

    await t.mutation(
      applySync,
      snapshot({
        eventId: "evt_b",
        sourceVersion: 2,
        scope: orgScopeMeta,
        entities: {
          ...emptyEntities(),
          principals: [
            {
              principalId: "p_bob",
              type: "user",
              herculesAuthUserId: "user_bob",
              status: "active",
              joinedAt: 200,
              updatedAt: 200,
            },
          ],
        },
      }),
    );

    await t.run(async (ctx) => {
      const all = await ctx.db.query("principals").collect();
      const byScope = new Map<string, string[]>();
      for (const p of all) {
        const list = byScope.get(p.accessScopeId) ?? [];
        list.push(p.principalId);
        byScope.set(p.accessScopeId, list);
      }
      expect(byScope.get("scope_default")).toEqual(["p_alice"]);
      expect(byScope.get("scope_acme")).toEqual(["p_bob"]);

      const state = await ctx.db.query("sync_state").unique();
      expect(state!.sourceVersion).toBe(2);
    });
  });

  test("event rejected with version_gap when state ahead", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshot({ sourceVersion: 5 }));

    const result = await t.mutation(applySync, event({ sourceVersion: 7 }));
    expect(result).toEqual({
      ok: false,
      status: "version_gap",
      currentVersion: 5,
      expectedVersion: 6,
      receivedVersion: 7,
    });
  });

  test("event rejected as duplicate when sourceVersion not advanced", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshot({ sourceVersion: 5 }));

    const result = await t.mutation(applySync, event({ sourceVersion: 5 }));
    expect(result).toEqual({ ok: true, status: "duplicate", acknowledgedVersion: 5 });
  });

  test("event applies a principal upsert and bumps per-app version", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshot({ sourceVersion: 5 }));

    const result = await t.mutation(
      applySync,
      event({
        sourceVersion: 6,
        eventId: "evt_p1",
        changes: [{ entityType: "principal", entityId: "p_carol", operation: "upsert" }],
        entities: {
          ...emptyEntities(),
          principals: [
            {
              principalId: "p_carol",
              type: "user",
              herculesAuthUserId: "user_carol",
              status: "active",
              joinedAt: 300,
              updatedAt: 300,
            },
          ],
        },
      }),
    );
    expect(result).toEqual({ ok: true, status: "applied", acknowledgedVersion: 6 });

    await t.run(async (ctx) => {
      const state = await ctx.db.query("sync_state").unique();
      expect(state!.sourceVersion).toBe(6);
      const carol = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "p_carol"))
        .unique();
      expect(carol).not.toBeNull();
      expect(carol!.joinedAt).toBe(300);
    });
  });

  test("event for a different scope upserts in the right scope without touching others", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshot({ sourceVersion: 1 }));
    await t.mutation(
      applySync,
      snapshot({ sourceVersion: 2, eventId: "evt_acme", scope: orgScopeMeta }),
    );

    const result = await t.mutation(
      applySync,
      event({
        sourceVersion: 3,
        eventId: "evt_acme_role",
        scope: orgScopeMeta,
        changes: [{ entityType: "role", entityId: "role_admin", operation: "upsert" }],
        entities: {
          ...emptyEntities(),
          roles: [
            {
              roleId: "role_admin",
              accessScopeId: "scope_acme",
              key: "admin",
              kind: "system",
              name: "Admin",
              updatedAt: 1,
            },
          ],
        },
      }),
    );
    expect(result).toEqual({ ok: true, status: "applied", acknowledgedVersion: 3 });

    await t.run(async (ctx) => {
      const roles = await ctx.db.query("roles").collect();
      expect(roles).toHaveLength(1);
      expect(roles[0]!.accessScopeId).toBe("scope_acme");
    });
  });

  test("event with cross-scope rekey is refused", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      snapshot({
        sourceVersion: 1,
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
        },
      }),
    );

    await expect(
      t.mutation(
        applySync,
        event({
          sourceVersion: 2,
          eventId: "evt_rekey",
          scope: orgScopeMeta,
          changes: [{ entityType: "principal", entityId: "p_alice", operation: "upsert" }],
          entities: {
            ...emptyEntities(),
            principals: [
              {
                principalId: "p_alice",
                type: "user",
                herculesAuthUserId: "user_alice",
                status: "active",
                joinedAt: 100,
                updatedAt: 200,
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/Refusing to rekey/);
  });

  test("scope status update flips status from active to disabled", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, snapshot({ sourceVersion: 1, scope: orgScopeMeta }));

    await t.mutation(
      applySync,
      event({
        sourceVersion: 2,
        eventId: "evt_disable",
        scope: { ...orgScopeMeta, status: "disabled", updatedAt: 2 },
      }),
    );

    await t.run(async (ctx) => {
      const scope = await ctx.db
        .query("scopes")
        .withIndex("by_scope_id", (q) => q.eq("accessScopeId", "scope_acme"))
        .unique();
      expect(scope!.status).toBe("disabled");
    });
  });

  test("applies grants with both principal-subject and scope-subject shapes", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      snapshot({
        sourceVersion: 1,
        scope: orgScopeMeta,
        entities: {
          ...emptyEntities(),
          grants: [
            {
              grantId: "grant_principal",
              subjectPrincipalId: "p_alice_acme",
              relationKind: "role",
              roleId: "role_admin",
              effect: "allow",
              objectType: "scope",
              objectId: "scope_acme",
              updatedAt: 100,
            },
            {
              grantId: "grant_scope_subject",
              subjectScopeId: "scope_other_org",
              relationKind: "role",
              roleId: "role_reader",
              effect: "allow",
              objectType: "scope",
              objectId: "scope_acme",
              updatedAt: 101,
            },
          ],
        },
      }),
    );

    await t.run(async (ctx) => {
      const grants = await ctx.db
        .query("grants")
        .withIndex("by_object_scope", (q) => q.eq("objectScopeId", "scope_acme"))
        .collect();
      expect(grants).toHaveLength(2);
      const byGrantId = new Map(grants.map((g) => [g.grantId, g]));
      const principalGrant = byGrantId.get("grant_principal");
      expect(principalGrant?.subjectPrincipalId).toBe("p_alice_acme");
      expect(principalGrant?.subjectScopeId).toBeUndefined();
      expect(principalGrant?.objectScopeId).toBe("scope_acme");
      const scopeGrant = byGrantId.get("grant_scope_subject");
      expect(scopeGrant?.subjectPrincipalId).toBeUndefined();
      expect(scopeGrant?.subjectScopeId).toBe("scope_other_org");
      expect(scopeGrant?.objectScopeId).toBe("scope_acme");
    });
  });

  test("cross-objectScope rekey on a grant is refused", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      snapshot({
        sourceVersion: 1,
        scope: baseScopeMeta,
        entities: {
          ...emptyEntities(),
          grants: [
            {
              grantId: "grant_alice_default",
              subjectPrincipalId: "p_alice_default",
              relationKind: "role",
              roleId: "role_owner",
              effect: "allow",
              objectType: "scope",
              objectId: "scope_default",
              updatedAt: 1,
            },
          ],
        },
      }),
    );

    await expect(
      t.mutation(
        applySync,
        event({
          sourceVersion: 2,
          eventId: "evt_rekey_grant",
          scope: orgScopeMeta,
          changes: [{ entityType: "grant", entityId: "grant_alice_default", operation: "upsert" }],
          entities: {
            ...emptyEntities(),
            grants: [
              {
                grantId: "grant_alice_default",
                subjectPrincipalId: "p_alice_default",
                relationKind: "role",
                roleId: "role_owner",
                effect: "allow",
                objectType: "scope",
                objectId: "scope_acme",
                updatedAt: 2,
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/Refusing to rekey grant/);
  });
});
