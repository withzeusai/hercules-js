// Regression tests for the verified projection-consumer authorization fail-opens.
//
// Each case reproduces the runtime escalation and then asserts it is closed. The
// PARSE-boundary half of every fix lives in shared/projection-protocol.test.ts
// (a malformed wire payload is rejected before it can be applied). This file
// covers the DEFENSE-IN-DEPTH half: even if a malformed row reaches the mirror
// (a bypassed parse fence, a future producer bug), the readers must still fail
// closed. We therefore install the golden snapshot through the real applySync and
// then mutate the mirror DIRECTLY (t.run) to plant the corrupted state, which the
// parse fence would otherwise forbid, before exercising the real consumer
// queries (checks.ts authorize / queries.ts listMyRoles).

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { componentModules as modules } from "../../test/component-modules";
import snapshotFixture from "../shared/__fixtures__/projection-v3/snapshot.json";
import schema from "./schema";

const applySync = makeFunctionReference<"mutation">("sync:applySync");
const authorize = makeFunctionReference<
  "query",
  Record<string, unknown>,
  { allowed: boolean; reasonCode: string }
>("checks:authorize");
const listMyRoles = makeFunctionReference<
  "query",
  Record<string, unknown>,
  Array<{ roleId: string; roleKey: string; roleName: string; roleKind: string }>
>("queries:listMyRoles");

const GOLDEN_ISSUER = "hercules-platform:cd_demo";
const DEFAULT_SCOPE_SENTINEL = "__hercules_default_scope__";

type ConvexTest = TestConvex<typeof schema>;

async function ingestGolden(t: ConvexTest): Promise<void> {
  const result = (await t.mutation(applySync, snapshotFixture as never)) as { ok: boolean };
  expect(result.ok).toBe(true);
}

describe("E1 - impersonation via a group principal carrying a victim's authUserId", () => {
  test("a group principal with the victim's herculesAuthUserId is NOT authorized as that user", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // The default-scope admin (u_alice) is a `user` principal pr_default_alice.
    // Plant a corrupted mirror: flip that principal to a `group` while it keeps
    // u_alice's herculesAuthUserId. The evaluator's by_scope_auth_user lookup
    // resolves on (scope, herculesAuthUserId) with no type guard pre-fix, so a
    // group principal would have been authorized as u_alice.
    await t.run(async (ctx) => {
      const principal = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_alice"))
        .unique();
      if (!principal) throw new Error("fixture principal missing");
      await ctx.db.patch(principal._id, { type: "group" });
    });

    // u_alice is the deployment admin; app.docs:read is allowed for a real admin.
    // After the fix the group principal resolves to nothing, so the decision is a
    // fail-closed deny (principal_missing).
    const decision = await t.query(authorize, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_alice`,
      scopeId: "as_default",
      permission: "app.docs:read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_missing");
  });

  test("the same request resolves as a real user principal (control)", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    const decision = await t.query(authorize, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_alice`,
      scopeId: "as_default",
      permission: "app.docs:read",
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("E3 - a blocked group must grant nothing", () => {
  test("a binding reached through a blocked group does not confer the group's role", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // u_bob already holds app.docs:read (member role) and a direct app.docs:write
    // grant in the golden snapshot, so neither isolates the group path. Add a
    // FRESH catalog permission (app.reports:read, a concrete delegable verb) that
    // u_bob can reach ONLY through an Admin (default-wildcard) role. Then build a
    // group that holds the admin role and make u_bob a member of it.
    await t.run(async (ctx) => {
      const now = 1780444800000;
      await ctx.db.insert("permissions", {
        accessScopeId: "as_default",
        permissionId: "perm_reports_read",
        key: "app.reports:read",
        resourceType: "app.reports",
        action: "read",
        classification: "delegable",
        tenantAssignable: true,
        updatedAt: now,
      });
      await ctx.db.insert("principals", {
        accessScopeId: "as_default",
        principalId: "pr_default_admins_group",
        type: "group",
        status: "active",
        joinedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("principal_memberships", {
        accessScopeId: "as_default",
        groupPrincipalId: "pr_default_admins_group",
        memberPrincipalId: "pr_default_bob",
        updatedAt: now,
      });
      await ctx.db.insert("role_bindings", {
        bindingId: "rb_default_group_admin",
        subjectPrincipalId: "pr_default_admins_group",
        roleId: "role_admin",
        accessScopeId: "as_default",
        updatedAt: now,
      });
    });

    // Control: with the group active, u_bob inherits admin and the Admin default
    // wildcard grants app.reports:read (a delegable, non-owner-only permission).
    const whileActive = await t.query(authorize, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_bob`,
      scopeId: "as_default",
      permission: "app.reports:read",
    });
    expect(whileActive.allowed).toBe(true);

    // Block the group.
    await t.run(async (ctx) => {
      const group = await ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "pr_default_admins_group"))
        .unique();
      if (!group) throw new Error("group principal missing");
      await ctx.db.patch(group._id, { status: "blocked" });
    });

    // u_bob's own member role does NOT grant app.reports:read; the only path was
    // the blocked group's admin binding. After the fix the blocked group grants
    // nothing, so the permission is denied.
    const whileBlocked = await t.query(authorize, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_bob`,
      scopeId: "as_default",
      permission: "app.reports:read",
    });
    expect(whileBlocked.allowed).toBe(false);
  });

  test("a membership pointing at a non-group principal grants nothing", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // u_bob "joins" a group that is actually a USER principal (pr_default_alice,
    // the default-scope admin). Admin's default wildcard grants the fresh
    // app.reports:read permission, but a membership only confers a real, active
    // GROUP's authority, so the admin authority must NOT leak to u_bob.
    await t.run(async (ctx) => {
      const now = 1780444800000;
      await ctx.db.insert("permissions", {
        accessScopeId: "as_default",
        permissionId: "perm_reports_read",
        key: "app.reports:read",
        resourceType: "app.reports",
        action: "read",
        classification: "delegable",
        tenantAssignable: true,
        updatedAt: now,
      });
      await ctx.db.insert("principal_memberships", {
        accessScopeId: "as_default",
        groupPrincipalId: "pr_default_alice",
        memberPrincipalId: "pr_default_bob",
        updatedAt: now,
      });
    });

    const decision = await t.query(authorize, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_bob`,
      scopeId: "as_default",
      permission: "app.reports:read",
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("E4 - cross-scope escalation is not written or honored", () => {
  test("a snapshot scope-A block targeting scope B is rejected and writes nothing", async () => {
    const t = convexTest(schema, modules);

    // Take the golden snapshot and re-point the default scope's Admin role binding
    // at the ORG scope (as_org1). This is the escalation: a default-scope block
    // that grants the Admin role inside as_org1 (a foreign scope). applySync must
    // reject it (invalid_payload) and install NOTHING.
    const escalation = structuredClone(snapshotFixture) as {
      scopes: { scope: { accessScopeId: string }; roleBindings: { accessScopeId: string }[] }[];
    };
    escalation.scopes[0]!.roleBindings[0]!.accessScopeId = "as_org1";

    const result = (await t.mutation(applySync, escalation as never)) as {
      ok: boolean;
      status: string;
    };
    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid_payload");

    // The whole snapshot is atomic, so a rejected parse leaves the mirror empty.
    const installed = await t.run(async (ctx) => ({
      roleBindings: (await ctx.db.query("role_bindings").collect()).length,
      scopes: (await ctx.db.query("scopes").collect()).length,
      syncState: await ctx.db.query("sync_state").unique(),
    }));
    expect(installed.roleBindings).toBe(0);
    expect(installed.scopes).toBe(0);
    expect(installed.syncState).toBeNull();
  });

  test("a clean snapshot pins every embedded row to its enclosing scope", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // Every binding/override/tenant role row written by the snapshot must carry
    // the accessScopeId of the scope block that contained it, never a foreign
    // scope. as_default's rows are pinned to as_default; as_org1's to as_org1.
    // This proves the SECOND layer (sync.ts pins to the enclosing scope) holds
    // even for a payload the parse fence accepts.
    const stray = await t.run(async (ctx) => {
      const bindings = await ctx.db.query("role_bindings").collect();
      const overrides = await ctx.db.query("role_permission_overrides").collect();
      const tenantRoles = (await ctx.db.query("roles").collect()).filter(
        (r) => r.source === "tenant",
      );
      const defaultBindings = bindings.filter((b) => b.bindingId.startsWith("rb_default_"));
      const orgBindings = bindings.filter((b) => b.bindingId.startsWith("rb_org1_"));
      return {
        defaultMisplaced: defaultBindings.filter((b) => b.accessScopeId !== "as_default").length,
        orgMisplaced: orgBindings.filter((b) => b.accessScopeId !== "as_org1").length,
        overrideMisplaced: overrides.filter((o) => o.accessScopeId !== "as_org1").length,
        tenantRoleMisplaced: tenantRoles.filter((r) => r.accessScopeId !== "as_org1").length,
      };
    });
    expect(stray).toEqual({
      defaultMisplaced: 0,
      orgMisplaced: 0,
      overrideMisplaced: 0,
      tenantRoleMisplaced: 0,
    });
  });

  test("an event scope-A delta nesting a scope-B binding is rejected and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    const beforeVersion = await t.run(async (ctx) => {
      const state = await ctx.db.query("sync_state").unique();
      return state?.sourceVersion;
    });

    // A scope-A (as_default) delta whose embedded permission binding targets the
    // org scope (as_org1). The parse fence rejects the cross-scope binding, so
    // applySync returns invalid_payload and nothing is written.
    const event = {
      type: "access.projection.event" as const,
      schemaVersion: 3 as const,
      eventId: "evt_e4_cross_scope_0001",
      sourceVersion: 8,
      scopes: [
        {
          accessScopeId: "as_default",
          changes: [
            {
              entityType: "permission_binding" as const,
              bindingId: "pb_e4_cross_scope",
              operation: "upsert" as const,
            },
          ],
          principals: [],
          principalMemberships: [],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [],
          permissionBindings: [
            {
              bindingId: "pb_e4_cross_scope",
              subjectPrincipalId: "pr_default_bob",
              permissionId: "perm_docs_write",
              effect: "allow" as const,
              // Foreign scope: this binding would land in as_org1.
              accessScopeId: "as_org1",
              updatedAt: 1780444800000,
            },
          ],
        },
      ],
    };

    const result = (await t.mutation(applySync, event as never)) as { ok: boolean; status: string };
    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid_payload");

    const after = await t.run(async (ctx) => {
      const state = await ctx.db.query("sync_state").unique();
      const binding = await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", "pb_e4_cross_scope"))
        .unique();
      return { version: state?.sourceVersion, binding };
    });
    expect(after.binding).toBeNull();
    // The version pointer never advanced past the snapshot's, so the event was
    // not applied.
    expect(after.version).toBe(beforeVersion);
  });

  test("a clean event delta pins the embedded binding to its enclosing scope", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // A well-formed delta (enclosing as_default, embedded as_default) writes the
    // binding pinned to the enclosing scope. Confirms the apply layer pins on the
    // accepted path too.
    const event = {
      type: "access.projection.event" as const,
      schemaVersion: 3 as const,
      eventId: "evt_e4_pin_0001",
      sourceVersion: 8,
      scopes: [
        {
          accessScopeId: "as_default",
          changes: [
            {
              entityType: "permission_binding" as const,
              bindingId: "pb_e4_default_alice_read",
              operation: "upsert" as const,
            },
          ],
          principals: [],
          principalMemberships: [],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [],
          permissionBindings: [
            {
              bindingId: "pb_e4_default_alice_read",
              subjectPrincipalId: "pr_default_alice",
              permissionId: "perm_docs_read",
              effect: "allow" as const,
              accessScopeId: "as_default",
              updatedAt: 1780444800000,
            },
          ],
        },
      ],
    };

    const result = (await t.mutation(applySync, event as never)) as { ok: boolean };
    expect(result.ok).toBe(true);

    const written = await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("permission_bindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", "pb_e4_default_alice_read"))
        .unique();
      return binding?.accessScopeId;
    });
    expect(written).toBe("as_default");
  });
});

describe("E5 - listMyRoles resolves the default-scope sentinel", () => {
  test("listMyRoles(__hercules_default_scope__) returns the caller's default-scope roles", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    // Pre-fix: the sentinel was used as a literal accessScopeId, matching no
    // scope, so the result was always []. After resolving the sentinel, u_alice
    // (the default-scope admin) gets the Admin role back.
    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_alice`,
      scopeId: DEFAULT_SCOPE_SENTINEL,
    });
    expect(roles).toEqual([
      { roleId: "role_admin", roleKey: "admin", roleName: "Admin", roleKind: "system" },
    ]);
  });

  test("the explicit default-scope id resolves identically (control)", async () => {
    const t = convexTest(schema, modules);
    await ingestGolden(t);

    const viaSentinel = await t.query(listMyRoles, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_alice`,
      scopeId: DEFAULT_SCOPE_SENTINEL,
    });
    const viaExplicit = await t.query(listMyRoles, {
      tokenIdentifier: `${GOLDEN_ISSUER}|u_alice`,
      scopeId: "as_default",
    });
    expect(viaSentinel).toEqual(viaExplicit);
  });
});
