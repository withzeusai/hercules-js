import type { DataModelFromSchemaDefinition, GenericMutationCtx } from "convex/server";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { componentModules } from "../../test/component-modules";

// Component functions live in the `queries` module (src/component/queries.ts,
// mounted as `queries` by componentModules).
const q = <Name extends string>(name: Name) => makeFunctionReference<"query">(`queries:${name}`);

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type SeedCtx = GenericMutationCtx<DataModel>;

const ISSUER = "https://issuer.example";
function token(subject: string): string {
  return `${ISSUER}|${subject}`;
}

function harness() {
  return convexTest(schema, componentModules);
}

async function addSyncState(ctx: SeedCtx): Promise<void> {
  await ctx.db.insert("sync_state", {
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    lastSyncedAt: 0,
  });
}

describe("generic per-table reads", () => {
  test("tenantsList filters by isPrimaryTenant and tenantsGet resolves by id/primary", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("tenants", {
        id: "P",
        name: "Primary",
        isPrimaryTenant: true,
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: null,
        updatedAt: 0,
        sourceVersion: 1,
      });
      await ctx.db.insert("tenants", {
        id: "S",
        name: "Secondary",
        isPrimaryTenant: false,
        status: "disabled",
        accountEntryMode: "open",
        defaultRoleId: null,
        updatedAt: 0,
        sourceVersion: 1,
      });
    });

    const all = await t.query(q("tenantsList"), {});
    expect(all.items.map((row: { id: string }) => row.id).sort()).toEqual(["P", "S"]);
    // Records drop Convex system fields + sourceVersion.
    expect(all.items[0]).not.toHaveProperty("_id");
    expect(all.items[0]).not.toHaveProperty("sourceVersion");

    const primaries = await t.query(q("tenantsList"), { isPrimaryTenant: true });
    expect(primaries.items.map((row: { id: string }) => row.id)).toEqual(["P"]);

    const active = await t.query(q("tenantsList"), { status: "active" });
    expect(active.items.map((row: { id: string }) => row.id)).toEqual(["P"]);

    const byId = await t.query(q("tenantsGet"), { id: "S" });
    expect(byId).toMatchObject({ id: "S", status: "disabled" });

    const byPrimary = await t.query(q("tenantsGet"), { primary: true });
    expect(byPrimary).toMatchObject({ id: "P", isPrimaryTenant: true });

    expect(await t.query(q("tenantsGet"), {})).toBeNull();
  });

  test("usersGet resolves by email and rolesGet narrows a shared key by tenantId", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        id: "u1",
        name: "User One",
        email: "one@example.com",
        emailVerified: true,
        phoneVerified: false,
        updatedAt: 0,
        sourceVersion: 1,
      });
      // Two roles sharing the key "editor": one shared, one tenant-scoped.
      await ctx.db.insert("roles", {
        id: "r-shared",
        key: "editor",
        name: "Editor",
        description: null,
        tenantId: null,
        isAppScope: false,
        updatedAt: 0,
        sourceVersion: 1,
      });
      await ctx.db.insert("roles", {
        id: "r-tenant",
        key: "editor",
        name: "Editor",
        description: null,
        tenantId: "T",
        isAppScope: false,
        updatedAt: 0,
        sourceVersion: 1,
      });
    });

    expect(await t.query(q("usersGet"), { email: "one@example.com" })).toMatchObject({ id: "u1" });
    expect(await t.query(q("usersGet"), { email: "missing@example.com" })).toBeNull();

    const tenantScoped = await t.query(q("rolesGet"), { key: "editor", tenantId: "T" });
    expect(tenantScoped).toMatchObject({ id: "r-tenant", tenantId: "T" });

    const shared = await t.query(q("rolesGet"), { key: "editor", tenantId: null });
    expect(shared).toMatchObject({ id: "r-shared", tenantId: null });

    const appScoped = await t.query(q("rolesList"), { tenantId: null });
    expect(appScoped.items.map((row: { id: string }) => row.id)).toEqual(["r-shared"]);
  });

  test("tenantMembershipsList filters and composite-key gets resolve", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("tenant_memberships", {
        id: "m1",
        tenantId: "T",
        userId: "u1",
        status: "active",
        updatedAt: 0,
        sourceVersion: 1,
      });
      await ctx.db.insert("tenant_memberships", {
        id: "m2",
        tenantId: "T",
        userId: "u2",
        status: "blocked",
        updatedAt: 0,
        sourceVersion: 1,
      });
      await ctx.db.insert("group_memberships", {
        groupId: "g1",
        membershipId: "m1",
        tenantId: "T",
        updatedAt: 0,
        sourceVersion: 1,
      });
      await ctx.db.insert("role_permissions", {
        roleId: "r1",
        permissionId: "p1",
        updatedAt: 0,
        sourceVersion: 1,
      });
    });

    const active = await t.query(q("tenantMembershipsList"), { tenantId: "T", status: "active" });
    expect(active.items.map((row: { id: string }) => row.id)).toEqual(["m1"]);

    const byUser = await t.query(q("tenantMembershipsList"), { userId: "u2" });
    expect(byUser.items.map((row: { id: string }) => row.id)).toEqual(["m2"]);

    const membership = await t.query(q("tenantMembershipsGet"), { tenantId: "T", userId: "u1" });
    expect(membership).toMatchObject({ id: "m1" });

    const gm = await t.query(q("groupMembershipsGet"), { groupId: "g1", membershipId: "m1" });
    expect(gm).toMatchObject({ groupId: "g1", membershipId: "m1", tenantId: "T" });
    expect(
      await t.query(q("groupMembershipsGet"), { groupId: "g1", membershipId: "mX" }),
    ).toBeNull();

    const rp = await t.query(q("rolePermissionsGet"), { roleId: "r1", permissionId: "p1" });
    expect(rp).toMatchObject({ roleId: "r1", permissionId: "p1" });
  });
});

describe("listMyGroups (caller-centric, gated)", () => {
  async function seed(ctx: SeedCtx, membershipStatus: "active" | "blocked"): Promise<void> {
    await addSyncState(ctx);
    await ctx.db.insert("tenants", {
      id: "P",
      name: "Primary",
      isPrimaryTenant: true,
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: null,
      updatedAt: 0,
      sourceVersion: 1,
    });
    await ctx.db.insert("tenant_memberships", {
      id: "m1",
      tenantId: "P",
      userId: "u1",
      status: membershipStatus,
      updatedAt: 0,
      sourceVersion: 1,
    });
    await ctx.db.insert("groups", {
      id: "g1",
      tenantId: "P",
      name: "Alpha",
      status: "active",
      updatedAt: 0,
      sourceVersion: 1,
    });
    await ctx.db.insert("group_memberships", {
      groupId: "g1",
      membershipId: "m1",
      tenantId: "P",
      updatedAt: 0,
      sourceVersion: 1,
    });
  }

  test("returns the active caller's groups in the resolved tenant", async () => {
    const t = harness();
    await t.run((ctx) => seed(ctx, "active"));
    const groups = await t.query(q("listMyGroups"), { tokenIdentifier: token("u1") });
    expect(groups).toEqual([{ groupId: "g1", name: "Alpha", status: "active" }]);
  });

  test("returns [] for a non-active membership", async () => {
    const t = harness();
    await t.run((ctx) => seed(ctx, "blocked"));
    expect(await t.query(q("listMyGroups"), { tokenIdentifier: token("u1") })).toEqual([]);
  });

  test("returns [] when the token issuer is not the expected issuer", async () => {
    const t = harness();
    await t.run((ctx) => seed(ctx, "active"));
    const groups = await t.query(q("listMyGroups"), {
      tokenIdentifier: `https://evil.example|u1`,
    });
    expect(groups).toEqual([]);
  });
});
