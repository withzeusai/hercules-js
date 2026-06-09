// Consumer PARITY + INGEST tests for the v3 projection rewrite.
//
// These prove that a producer-shipped v3 payload, once ingested through the REAL
// `applySync` mutation into the REAL v3 schema, evaluates IDENTICALLY to what the
// producer intended (the cross-repo golden contract). They exercise two real,
// already-rewritten layers end to end:
//   1. ingestion  — component/sync.ts -> component/schema.ts (the v3 tables),
//   2. the algebra — the PURE evaluateAccess() in component/authz.ts.
//
// The intermediate "assemble entries from the mirror" reader (effective.ts /
// queries.ts / checks.ts) is still being rewired by the assembly agents and does
// NOT yet compile against the v3 schema, so it is NOT used here. Instead this file
// reproduces the documented v3 assembly model (base role_permissions folded with
// per-scope role_permission_overrides, principal/role permission_bindings, and the
// per-scope effective-wildcard derivation) directly over the ingested tables, then
// feeds the assembled (wildcard, entries) into the canonical evaluateAccess(). That
// keeps the parity gate anchored on (a) the real ingestion and (b) the real,
// frozen algebra, which is exactly what the producer's expected-decisions.json
// asserts. When the assembly readers land, the same fixtures should drive the
// can()/authorize path and produce the same decisions.

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import eventCatalog from "../shared/__fixtures__/projection-v3/event-catalog.json";
import eventScope from "../shared/__fixtures__/projection-v3/event-scope.json";
import eventUser from "../shared/__fixtures__/projection-v3/event-user.json";
import expectedDecisions from "../shared/__fixtures__/projection-v3/expected-decisions.json";
import snapshotFixture from "../shared/__fixtures__/projection-v3/snapshot.json";
import { evaluateAccess, type ApplicableEntry, type WildcardMode } from "./authz";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);
const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const authorize = makeFunctionReference<"query">("component/checks:authorize");

const GOLDEN_ISSUER = "hercules-platform:cd_demo";

// principalId -> herculesAuthUserId, from the golden snapshot. The real
// authorize() path keys off the auth user id carried in the JWT subject.
const GOLDEN_AUTH_USER_BY_PRINCIPAL: Record<string, string> = {
  pr_default_alice: "u_alice",
  pr_default_bob: "u_bob",
  pr_org1_alice: "u_alice",
};

type ConvexTest = TestConvex<typeof schema>;

// ───────────────────────────────────────────────────────────────────────────
// Consumer evaluator over the ingested v3 mirror.
//
// This is a faithful re-implementation of the documented v3 assembly model. It
// reads ONLY the v3 tables (no `grants`, no roles.kind/wildcard, no
// role_permissions.accessScopeId) and produces the exact (wildcard, entries)
// pair the algebra consumes. It deliberately mirrors effective.ts's intended
// behavior so this file becomes the executable spec the assembly readers must
// match.
// ───────────────────────────────────────────────────────────────────────────

type Decision = "allow" | "deny";

type CatalogPermission = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
};

// A role's net permission contribution in a given scope: the catalog base map
// folded with that scope's overrides. `rawAllow` tracks ONLY the allow rows and
// is the narrowing signal for a `default` (Admin) role — a deny-only override
// leaves it empty, so Admin stays wildcard-default.
type RoleContribution = { allow: Set<string>; deny: Set<string>; rawAllow: Set<string> };

async function evaluate(
  t: ConvexTest,
  args: {
    subjectPrincipalId: string;
    scopeId: string;
    resourceType: string;
    action: string;
    resourceId?: string;
  },
): Promise<Decision> {
  return await t.run(async (ctx) => {
    const defaultScope = await ctx.db
      .query("scopes")
      .withIndex("by_kind", (q) => q.eq("kind", "default"))
      .unique();
    if (!defaultScope) return "deny";
    const defaultScopeId = defaultScope.accessScopeId;

    const scope = await ctx.db
      .query("scopes")
      .withIndex("by_scope_id", (q) => q.eq("accessScopeId", args.scopeId))
      .unique();
    if (!scope) return "deny";

    const principal = await ctx.db
      .query("principals")
      .withIndex("by_principal_id", (q) => q.eq("principalId", args.subjectPrincipalId))
      .unique();
    if (!principal || principal.status !== "active") return "deny";

    // Catalog permission lookups (catalog is pinned to the default scope id).
    const catalogPermissions = (await ctx.db
      .query("permissions")
      .withIndex("by_scope", (q) => q.eq("accessScopeId", defaultScopeId))
      .collect()) as CatalogPermission[];
    const permissionById = new Map(catalogPermissions.map((p) => [p.permissionId, p]));

    // 1. Effective principal ids: the principal plus any groups it belongs to in
    // this scope (none in the fixtures, but the union is part of the model).
    const principalIds = new Set([args.subjectPrincipalId]);
    for (const membership of await ctx.db
      .query("principal_memberships")
      .withIndex("by_member", (q) =>
        q.eq("accessScopeId", args.scopeId).eq("memberPrincipalId", args.subjectPrincipalId),
      )
      .collect()) {
      principalIds.add(membership.groupPrincipalId);
    }

    // 2. Effective role ids: scope-object role bindings (resourceType/resourceId
    // undefined) for any effective principal in this scope.
    const roleIds = new Set<string>();
    for (const pid of principalIds) {
      for (const binding of await ctx.db
        .query("role_bindings")
        .withIndex("by_subject_principal", (q) => q.eq("subjectPrincipalId", pid))
        .collect()) {
        if (
          binding.accessScopeId === args.scopeId &&
          binding.resourceType === undefined &&
          binding.resourceId === undefined
        ) {
          roleIds.add(binding.roleId);
        }
      }
    }

    // Resolve a role's net contribution in THIS scope: base role_permissions
    // folded, then this scope's role_permission_overrides layered on top.
    async function resolveContribution(roleId: string): Promise<RoleContribution> {
      const contribution: RoleContribution = {
        allow: new Set(),
        deny: new Set(),
        rawAllow: new Set(),
      };
      const base = await ctx.db
        .query("role_permissions")
        .withIndex("by_role", (q) => q.eq("roleId", roleId))
        .collect();
      foldRows(contribution, base);
      const overrides = await ctx.db
        .query("role_permission_overrides")
        .withIndex("by_scope_role", (q) => q.eq("accessScopeId", args.scopeId).eq("roleId", roleId))
        .collect();
      foldRows(contribution, overrides);
      return contribution;
    }

    // 3. Wildcard mode: immutable dominates default dominates none. A `default`
    // (Admin) role only KEEPS wildcard-default when it has NO enumerated allow in
    // this scope (rawAllow empty); once narrowed by an allow it drops to `none`
    // and its enumerated rows govern.
    let wildcard: WildcardMode = "none";
    const contributions = new Map<string, RoleContribution>();
    for (const roleId of roleIds) {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique();
      if (!role) continue;
      const contribution = await resolveContribution(roleId);
      contributions.set(roleId, contribution);
      if (role.baseWildcard === "immutable") {
        wildcard = "immutable";
      } else if (role.baseWildcard === "default" && contribution.rawAllow.size === 0) {
        if (wildcard !== "immutable") wildcard = "default";
      }
    }

    // 4. Assemble entries.
    const entries: ApplicableEntry[] = [];

    // 4a. Role contributions -> type-level allow / deny entries.
    for (const contribution of contributions.values()) {
      for (const permissionId of contribution.allow) {
        const permission = permissionById.get(permissionId);
        if (!permission) continue;
        entries.push({
          effect: "allow",
          resourceType: permission.resourceType,
          action: permission.action,
          objectType: "scope",
        });
      }
      for (const permissionId of contribution.deny) {
        const permission = permissionById.get(permissionId);
        if (!permission) continue;
        entries.push({
          effect: "deny",
          resourceType: permission.resourceType,
          action: permission.action,
          objectType: "scope",
        });
      }
    }

    // 4b. Permission bindings -> entries. Principal-subject bindings for any
    // effective principal, and role-subject bindings for any held role. Both the
    // scope-object form and (when requested) the matching resource-object form.
    const pushBinding = (binding: {
      permissionId: string;
      effect: "allow" | "deny";
      resourceType?: string;
      resourceId?: string;
    }) => {
      const permission = permissionById.get(binding.permissionId);
      if (!permission) return;
      const isInstanceLevel =
        binding.resourceType !== undefined && binding.resourceId !== undefined;
      entries.push({
        effect: binding.effect,
        resourceType: binding.resourceType ?? permission.resourceType,
        action: permission.action,
        objectType: isInstanceLevel ? "resource" : "scope",
        objectId: isInstanceLevel ? binding.resourceId : undefined,
      });
    };

    for (const pid of principalIds) {
      for (const binding of await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_principal", (q) => q.eq("subjectPrincipalId", pid))
        .collect()) {
        if (binding.accessScopeId !== args.scopeId) continue;
        pushBinding(binding);
      }
    }
    for (const roleId of roleIds) {
      for (const binding of await ctx.db
        .query("permission_bindings")
        .withIndex("by_subject_role", (q) => q.eq("subjectRoleId", roleId))
        .collect()) {
        if (binding.accessScopeId !== args.scopeId) continue;
        pushBinding(binding);
      }
    }

    // 5. Resolve the requested permission's canonical tuple by (resourceType,
    // action) and evaluate with the frozen algebra.
    const resolved = catalogPermissions.find(
      (p) => p.resourceType === args.resourceType && p.action === args.action,
    );
    if (!resolved) return "deny";

    return evaluateAccess({
      wildcard,
      entries,
      request: {
        resourceType: resolved.resourceType,
        action: resolved.action,
        classification: resolved.classification,
        objectId: args.resourceId,
      },
    });
  });
}

function foldRows(
  contribution: RoleContribution,
  rows: Array<{ permissionId: string; effect: "allow" | "deny" }>,
) {
  for (const row of rows) {
    if (row.effect === "allow") {
      contribution.rawAllow.add(row.permissionId);
      contribution.allow.add(row.permissionId);
      contribution.deny.delete(row.permissionId);
    }
  }
  for (const row of rows) {
    if (row.effect === "deny") {
      contribution.allow.delete(row.permissionId);
      contribution.deny.add(row.permissionId);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Ingest parity: every expected-decisions case evaluates as the producer says.
// ───────────────────────────────────────────────────────────────────────────

describe("v3 golden snapshot — ingest + decision parity", () => {
  test("the golden snapshot ingests cleanly through applySync", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(applySync, snapshotFixture as never);
    expect(result).toMatchObject({ ok: true, status: "applied", acknowledgedVersion: 7 });

    // Spot-check the install landed in the v3 tables.
    const counts = await t.run(async (ctx) => ({
      roles: (await ctx.db.query("roles").collect()).length,
      permissions: (await ctx.db.query("permissions").collect()).length,
      rolePermissions: (await ctx.db.query("role_permissions").collect()).length,
      roleBindings: (await ctx.db.query("role_bindings").collect()).length,
      permissionBindings: (await ctx.db.query("permission_bindings").collect()).length,
      overrides: (await ctx.db.query("role_permission_overrides").collect()).length,
      organizations: (await ctx.db.query("organizations").collect()).length,
      users: (await ctx.db.query("users").collect()).length,
    }));
    expect(counts).toEqual({
      roles: 5, // 4 catalog + 1 tenant (org_lead)
      permissions: 4,
      rolePermissions: 3,
      roleBindings: 4,
      permissionBindings: 1,
      overrides: 1,
      organizations: 1, // derived from the org scope
      users: 2,
    });
  });

  for (const decision of expectedDecisions as Array<{
    label: string;
    subjectPrincipalId: string;
    scopeId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    expect: Decision;
  }>) {
    test(`decision parity: ${decision.label}`, async () => {
      const t = convexTest(schema, modules);
      const ingest = await t.mutation(applySync, snapshotFixture as never);
      expect(ingest).toMatchObject({ ok: true, status: "applied" });

      const actual = await evaluate(t, {
        subjectPrincipalId: decision.subjectPrincipalId,
        scopeId: decision.scopeId,
        resourceType: decision.resourceType,
        action: decision.action,
        resourceId: decision.resourceId,
      });
      expect(actual).toBe(decision.expect);
    });
  }

  // End-to-end parity through the REAL shipping consumer query (component/
  // checks.ts authorize -> effective.ts assembly -> authz.ts evaluateAccess),
  // for the concrete-verb golden cases. The `manage`/`*` golden cases are NOT
  // driven here: checks.ts deliberately rejects a request whose resolved catalog
  // action is a superset token (`manage`/`*`) with `invalid_request`, because
  // real can() requests always carry a concrete verb. Those superset cases are
  // pure-algebra assertions and stay on the evaluateAccess parity above; here we
  // confirm the read/write cases resolve identically through the actual gate.
  const concreteVerbCases = (
    expectedDecisions as Array<{
      label: string;
      subjectPrincipalId: string;
      scopeId: string;
      action: string;
      resourceType: string;
      resourceId?: string;
      expect: Decision;
    }>
  ).filter((d) => d.action !== "manage" && d.action !== "*");

  for (const decision of concreteVerbCases) {
    test(`real authorize() parity: ${decision.label}`, async () => {
      const t = convexTest(schema, modules);
      const ingest = await t.mutation(applySync, snapshotFixture as never);
      expect(ingest).toMatchObject({ ok: true, status: "applied" });

      const authUserId = GOLDEN_AUTH_USER_BY_PRINCIPAL[decision.subjectPrincipalId];
      const result = (await t.query(authorize, {
        tokenIdentifier: `${GOLDEN_ISSUER}|${authUserId}`,
        scopeId: decision.scopeId,
        // The golden catalog keys follow `<resourceType>:<action>`.
        permission: `${decision.resourceType}:${decision.action}`,
        resourceType: decision.resourceType,
        resourceId: decision.resourceId,
      })) as { allowed: boolean };
      expect(result.allowed ? "allow" : "deny").toBe(decision.expect);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. C1 narrowing parity (the user-required tests).
// ───────────────────────────────────────────────────────────────────────────

// Minimal hand-built v3 snapshot so the C1 narrowing axes can be isolated. Admin
// (role_admin, baseWildcard "default") is bound to one principal in BOTH a
// default scope and an org scope. The org scope carries the narrowing overrides
// under test. app.docs:read and app.docs:write are the two governed permissions.
function c1Snapshot(orgOverrides: Array<{ permissionId: string; effect: "allow" | "deny" }>) {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 3,
    eventId: "evt_c1_snapshot",
    mode: "initialize",
    sourceVersion: 1,
    expectedIssuer: "hercules-platform:c1",
    catalog: {
      roles: [
        {
          roleId: "role_admin",
          key: "admin",
          source: "system",
          name: "Admin",
          baseWildcard: "default",
          updatedAt: 1,
        },
      ],
      permissions: [
        {
          permissionId: "perm_docs_read",
          key: "app.docs:read",
          resourceType: "app.docs",
          action: "read",
          classification: "delegable",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_docs_write",
          key: "app.docs:write",
          resourceType: "app.docs",
          action: "write",
          classification: "delegable",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
      rolePermissions: [],
    },
    users: [
      {
        herculesAuthUserId: "u_admin",
        name: "Ada Admin",
        email: "ada@c1.example",
        emailVerified: true,
        phoneVerified: false,
        updatedAt: 1,
      },
    ],
    scopes: [
      {
        scope: {
          accessScopeId: "as_default",
          name: "c1",
          kind: "default",
          status: "active",
          accountEntryMode: "open",
          defaultRoleId: "role_admin",
          updatedAt: 1,
        },
        principals: [
          {
            principalId: "pr_default_admin",
            type: "user",
            herculesAuthUserId: "u_admin",
            status: "active",
            joinedAt: 1,
            updatedAt: 1,
          },
        ],
        principalMemberships: [],
        roles: [],
        rolePermissionOverrides: [],
        roleBindings: [
          {
            bindingId: "rb_default_admin",
            subjectPrincipalId: "pr_default_admin",
            roleId: "role_admin",
            accessScopeId: "as_default",
            updatedAt: 1,
          },
        ],
        permissionBindings: [],
      },
      {
        scope: {
          accessScopeId: "as_org",
          name: "Org A",
          kind: "org",
          status: "active",
          accountEntryMode: "invite_only",
          defaultRoleId: "role_admin",
          updatedAt: 1,
        },
        principals: [
          {
            principalId: "pr_org_admin",
            type: "user",
            herculesAuthUserId: "u_admin",
            status: "active",
            joinedAt: 1,
            updatedAt: 1,
          },
        ],
        principalMemberships: [],
        roles: [],
        rolePermissionOverrides: orgOverrides.map((o) => ({
          accessScopeId: "as_org",
          roleId: "role_admin",
          permissionId: o.permissionId,
          effect: o.effect,
          updatedAt: 1,
        })),
        roleBindings: [
          {
            bindingId: "rb_org_admin",
            subjectPrincipalId: "pr_org_admin",
            roleId: "role_admin",
            accessScopeId: "as_org",
            updatedAt: 1,
          },
        ],
        permissionBindings: [],
      },
    ],
  };
}

// Drive the C1 scenario through the REAL shipping consumer query as well, so the
// narrowing is proven against the actual can() gate and not only the local
// re-implementation. Both C1 axes use concrete read/write verbs, which the
// authorize() path accepts (unlike `manage`).
async function c1Authorize(
  t: ConvexTest,
  args: { authUserId: string; scopeId: string; action: "read" | "write" },
): Promise<Decision> {
  const result = (await t.query(authorize, {
    tokenIdentifier: `hercules-platform:c1|${args.authUserId}`,
    scopeId: args.scopeId,
    permission: `app.docs:${args.action}`,
    resourceType: "app.docs",
  })) as { allowed: boolean };
  return result.allowed ? "allow" : "deny";
}

describe("C1 narrowing parity", () => {
  test("(a) an allow override narrows Admin THERE while it stays wildcard-default elsewhere", async () => {
    const t = convexTest(schema, modules);
    // Org scope narrows Admin with an ALLOW override on app.docs:read only.
    const result = await t.mutation(
      applySync,
      c1Snapshot([{ permissionId: "perm_docs_read", effect: "allow" }]) as never,
    );
    expect(result).toMatchObject({ ok: true, status: "applied" });

    // Scope B (default): Admin is NOT narrowed (no enumerated rows), so its
    // wildcard-default governs and a permission it never enumerated is allowed.
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_default_admin",
        scopeId: "as_default",
        resourceType: "app.docs",
        action: "write",
      }),
    ).resolves.toBe("allow");

    // Scope A (org): the allow override narrowed Admin to enumerated-governs.
    // The enumerated app.docs:read is allowed...
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_org_admin",
        scopeId: "as_org",
        resourceType: "app.docs",
        action: "read",
      }),
    ).resolves.toBe("allow");
    // ...but app.docs:write, which is NOT enumerated, is now DENIED there even
    // though Admin would allow it by wildcard-default in scope B. This is the
    // crux of C1: the narrowing is per-scope and downgrades the wildcard.
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_org_admin",
        scopeId: "as_org",
        resourceType: "app.docs",
        action: "write",
      }),
    ).resolves.toBe("deny");

    // Same three decisions through the real authorize() gate.
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_default", action: "write" }),
    ).resolves.toBe("allow");
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_org", action: "read" }),
    ).resolves.toBe("allow");
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_org", action: "write" }),
    ).resolves.toBe("deny");
  });

  test("(b) a deny-only override does NOT un-narrow Admin; it just subtracts that one permission", async () => {
    const t = convexTest(schema, modules);
    // Org scope carries ONLY a deny override on app.docs:write.
    const result = await t.mutation(
      applySync,
      c1Snapshot([{ permissionId: "perm_docs_write", effect: "deny" }]) as never,
    );
    expect(result).toMatchObject({ ok: true, status: "applied" });

    // Admin stays wildcard-default in the org scope (a deny does not populate
    // rawAllow), so an unrelated permission it never enumerated is still allowed.
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_org_admin",
        scopeId: "as_org",
        resourceType: "app.docs",
        action: "read",
      }),
    ).resolves.toBe("allow");

    // The deny still subtracts exactly the one permission it names.
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_org_admin",
        scopeId: "as_org",
        resourceType: "app.docs",
        action: "write",
      }),
    ).resolves.toBe("deny");

    // And in scope B (no override at all) Admin remains fully wildcard-default.
    await expect(
      evaluate(t, {
        subjectPrincipalId: "pr_default_admin",
        scopeId: "as_default",
        resourceType: "app.docs",
        action: "write",
      }),
    ).resolves.toBe("allow");

    // Same three decisions through the real authorize() gate.
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_org", action: "read" }),
    ).resolves.toBe("allow");
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_org", action: "write" }),
    ).resolves.toBe("deny");
    await expect(
      c1Authorize(t, { authUserId: "u_admin", scopeId: "as_default", action: "write" }),
    ).resolves.toBe("allow");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Event application + version algebra.
// ───────────────────────────────────────────────────────────────────────────

async function ingestSnapshot(t: ConvexTest) {
  const result = await t.mutation(applySync, snapshotFixture as never);
  expect(result).toMatchObject({ ok: true, status: "applied", acknowledgedVersion: 7 });
}

// The golden events form a strict version chain on top of the v7 snapshot:
//   v8 = event-catalog, v9 = event-user, v10 = event-scope.
// Events apply only at currentVersion + 1, so reaching a later event requires
// replaying its predecessors first. This advances the mirror up to (and
// including) the named target version.
async function ingestEventsThrough(t: ConvexTest, target: 8 | 9 | 10) {
  if (target >= 8) {
    expect(await t.mutation(applySync, eventCatalog as never)).toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 8,
    });
  }
  if (target >= 9) {
    expect(await t.mutation(applySync, eventUser as never)).toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 9,
    });
  }
  if (target >= 10) {
    expect(await t.mutation(applySync, eventScope as never)).toMatchObject({
      ok: true,
      status: "applied",
      acknowledgedVersion: 10,
    });
  }
}

describe("v3 event application", () => {
  test("event-catalog adds the new permission and base role-permission at v8", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t);

    const result = await t.mutation(applySync, eventCatalog as never);
    expect(result).toMatchObject({ ok: true, status: "applied", acknowledgedVersion: 8 });

    const state = await t.run(async (ctx) => ({
      permission: await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", "perm_docs_delete"))
        .unique(),
      rolePermission: await ctx.db
        .query("role_permissions")
        .withIndex("by_role_permission", (q) =>
          q.eq("roleId", "role_editor").eq("permissionId", "perm_docs_delete"),
        )
        .unique(),
    }));
    expect(state.permission).toMatchObject({
      key: "app.docs:delete",
      resourceType: "app.docs",
      action: "delete",
    });
    expect(state.rolePermission).toMatchObject({ effect: "allow" });
  });

  test("event-user renames the existing user at v9", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t);
    // v9 only applies after v8; replay the predecessor in the chain.
    await ingestEventsThrough(t, 9);

    const user = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", "u_alice"))
        .unique(),
    );
    expect(user).toMatchObject({ name: "Alice Carter", updatedAt: 1780358400000 });
  });

  test("event-scope blocks the principal and deletes its permission binding at v10", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t);

    // Precondition: the binding the event deletes exists after the snapshot.
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", "pb_default_bob_docswrite"))
        .unique(),
    );
    expect(before).not.toBeNull();

    // v10 only applies after v8 and v9; replay the chain up to and including it.
    await ingestEventsThrough(t, 10);

    const after = await t.run(async (ctx) => ({
      binding: await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", "pb_default_bob_docswrite"))
        .unique(),
      principal: await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_bob"))
        .unique(),
    }));
    expect(after.binding).toBeNull();
    expect(after.principal).toMatchObject({ status: "blocked" });
  });

  test("the full golden event chain (v8 -> v9 -> v10) applies in sequence", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t);
    await ingestEventsThrough(t, 10);

    // The mirror reflects every chained change: new catalog permission, renamed
    // user, blocked principal, deleted permission binding.
    const state = await t.run(async (ctx) => ({
      newPermission: await ctx.db
        .query("permissions")
        .withIndex("by_permission_id", (q) => q.eq("permissionId", "perm_docs_delete"))
        .unique(),
      alice: await ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", "u_alice"))
        .unique(),
      bob: await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_bob"))
        .unique(),
      deletedBinding: await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", "pb_default_bob_docswrite"))
        .unique(),
    }));
    expect(state.newPermission).toMatchObject({ key: "app.docs:delete" });
    expect(state.alice).toMatchObject({ name: "Alice Carter" });
    expect(state.bob).toMatchObject({ status: "blocked" });
    expect(state.deletedBinding).toBeNull();
  });

  test("applying an event at the WRONG version is rejected as version_gap", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t); // mirror is at v7

    // event-user is sourceVersion 9, but the next expected version is 8.
    const result = await t.mutation(applySync, eventUser as never);
    expect(result).toMatchObject({
      ok: false,
      status: "version_gap",
      currentVersion: 7,
      expectedVersion: 8,
      receivedVersion: 9,
    });

    // The rejected event left the mirror untouched: Alice keeps her snapshot name.
    const user = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_auth_user_id", (q) => q.eq("herculesAuthUserId", "u_alice"))
        .unique(),
    );
    expect(user).toMatchObject({ name: "Alice Anderson" });
  });

  test("an event before any snapshot is not_ready", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(applySync, eventCatalog as never);
    expect(result).toMatchObject({ ok: false, status: "not_ready", currentVersion: 0 });
  });

  test("re-delivering the snapshot eventId is an idempotent duplicate ack", async () => {
    const t = convexTest(schema, modules);
    await ingestSnapshot(t);
    const result = await t.mutation(applySync, snapshotFixture as never);
    expect(result).toMatchObject({ ok: true, status: "duplicate", acknowledgedVersion: 7 });
  });
});
