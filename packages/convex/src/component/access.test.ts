import type { DataModelFromSchemaDefinition, GenericMutationCtx } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { evaluateAccess, type AccessRequest } from "./access";
import schema from "./schema";
import { componentModules } from "../../test/component-modules";

// tokenIdentifier is composed as `${issuer}|${subject}` (parseTokenIdentifier
// splits on the LAST '|').
const ISSUER = "https://issuer.example";
function token(subject: string): string {
  return `${ISSUER}|${subject}`;
}

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type SeedCtx = GenericMutationCtx<DataModel>;
type MembershipStatus = DataModel["tenant_memberships"]["document"]["status"];

function harness() {
  return convexTest(schema, componentModules);
}

// ── seed helpers ──────────────────────────────────────────────────────────────
async function addSyncState(ctx: SeedCtx, issuer = ISSUER, sourceVersion = 1): Promise<void> {
  await ctx.db.insert("sync_state", {
    sourceVersion,
    expectedIssuer: issuer,
    lastSyncedAt: 0,
  });
}

async function addTenant(
  ctx: SeedCtx,
  id: string,
  opts: { primary?: boolean; status?: "active" | "disabled"; defaultRoleId?: string | null } = {},
): Promise<void> {
  await ctx.db.insert("tenants", {
    id,
    name: id,
    isPrimaryTenant: opts.primary ?? false,
    status: opts.status ?? "active",
    accountEntryMode: "open",
    defaultRoleId: opts.defaultRoleId ?? null,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addMembership(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  userId: string,
  status: MembershipStatus = "active",
): Promise<void> {
  await ctx.db.insert("tenant_memberships", {
    id,
    tenantId,
    userId,
    status,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addRole(
  ctx: SeedCtx,
  id: string,
  opts: { tenantId?: string | null; isAppScope?: boolean; key?: string } = {},
): Promise<void> {
  await ctx.db.insert("roles", {
    id,
    key: opts.key ?? id,
    name: id,
    description: null,
    tenantId: opts.tenantId === undefined ? null : opts.tenantId,
    isAppScope: opts.isAppScope ?? false,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addPermission(
  ctx: SeedCtx,
  id: string,
  key: string,
  isAppScope = false,
): Promise<void> {
  await ctx.db.insert("permissions", { id, key, isAppScope, updatedAt: 0, sourceVersion: 1 });
}

async function grant(ctx: SeedCtx, roleId: string, permissionId: string): Promise<void> {
  await ctx.db.insert("role_permissions", { roleId, permissionId, updatedAt: 0, sourceVersion: 1 });
}

async function addUserRoleAssignment(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  membershipId: string,
  roleId: string,
  expiresAt?: number,
): Promise<void> {
  await ctx.db.insert("user_role_assignments", {
    id,
    tenantId,
    membershipId,
    roleId,
    updatedAt: 0,
    sourceVersion: 1,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

async function addGroup(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  status: "active" | "disabled" = "active",
): Promise<void> {
  await ctx.db.insert("groups", { id, tenantId, name: id, status, updatedAt: 0, sourceVersion: 1 });
}

async function addGroupMembership(
  ctx: SeedCtx,
  groupId: string,
  membershipId: string,
  tenantId: string,
): Promise<void> {
  await ctx.db.insert("group_memberships", {
    groupId,
    membershipId,
    tenantId,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addGroupRoleAssignment(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  groupId: string,
  roleId: string,
  expiresAt?: number,
): Promise<void> {
  await ctx.db.insert("group_role_assignments", {
    id,
    tenantId,
    groupId,
    roleId,
    updatedAt: 0,
    sourceVersion: 1,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

async function addResourceType(
  ctx: SeedCtx,
  id: string,
  key: string,
  parentResourceTypeId: string | null = null,
): Promise<void> {
  await ctx.db.insert("resource_types", {
    id,
    key,
    name: key,
    parentResourceTypeId,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addResourceNode(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  resourceTypeId: string,
  externalId: string,
  parentId?: string,
): Promise<void> {
  await ctx.db.insert("resources", {
    id,
    tenantId,
    resourceTypeId,
    externalId,
    updatedAt: 0,
    ...(parentId === undefined ? {} : { parentId }),
  });
}

async function addUserResourceRoleAssignment(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  membershipId: string,
  roleId: string,
  resourceTypeId: string,
  externalId: string,
): Promise<void> {
  await ctx.db.insert("user_resource_role_assignments", {
    id,
    tenantId,
    membershipId,
    roleId,
    resourceTypeId,
    externalId,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

async function addGroupResourceRoleAssignment(
  ctx: SeedCtx,
  id: string,
  tenantId: string,
  groupId: string,
  roleId: string,
  resourceTypeId: string,
  externalId: string,
): Promise<void> {
  await ctx.db.insert("group_resource_role_assignments", {
    id,
    tenantId,
    groupId,
    roleId,
    resourceTypeId,
    externalId,
    updatedAt: 0,
    sourceVersion: 1,
  });
}

// ── guards ────────────────────────────────────────────────────────────────────
describe("evaluateAccess guards", () => {
  test("missing_identity when no token", async () => {
    const t = harness();
    const decision = await t.run((ctx) => evaluateAccess(ctx, { permissionKey: "app.doc:read" }));
    expect(decision).toMatchObject({ allowed: false, reasonCode: "missing_identity" });
  });

  test("invalid_identity when the token has no separator", async () => {
    const t = harness();
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: "no-separator", permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "invalid_identity" });
  });

  test("mirror_not_ready when there is no sync_state", async () => {
    const t = harness();
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "mirror_not_ready" });
  });

  test("unexpected_issuer when the token issuer differs", async () => {
    const t = harness();
    await t.run((ctx) => addSyncState(ctx, "https://other.example"));
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "unexpected_issuer" });
  });

  test("tenant_missing when the requested tenant does not exist", async () => {
    const t = harness();
    await t.run((ctx) => addSyncState(ctx));
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "ghost",
        permissionKey: "app.doc:read",
      }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "tenant_missing" });
  });

  test("tenant_disabled when the tenant is archived, even with a valid grant", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "T", { primary: true, status: "disabled" });
      await addMembership(ctx, "m1", "T", "u1");
      await addRole(ctx, "r1");
      await addPermission(ctx, "p1", "app.doc:read");
      await grant(ctx, "r1", "p1");
      await addUserRoleAssignment(ctx, "ura1", "T", "m1", "r1");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.doc:read",
      }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "tenant_disabled" });
  });

  test("permission_missing when the permission key is unknown", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.unknown:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "permission_missing" });
  });
});

// ── membership status ──────────────────────────────────────────────────────────
describe("evaluateAccess membership status", () => {
  async function seedTenantWithPermission(ctx: SeedCtx): Promise<void> {
    await addSyncState(ctx);
    await addTenant(ctx, "t-p", { primary: true });
    await addPermission(ctx, "perm-read", "app.doc:read");
  }

  test("membership_missing when the caller has no membership", async () => {
    const t = harness();
    await t.run(seedTenantWithPermission);
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "membership_missing" });
  });

  const cases: Array<[MembershipStatus, string]> = [
    ["pending_approval", "membership_pending_approval"],
    ["blocked", "membership_blocked"],
    ["suspended", "membership_suspended"],
    ["removed", "membership_removed"],
  ];
  for (const [status, reasonCode] of cases) {
    test(`${status} membership denies with ${reasonCode}`, async () => {
      const t = harness();
      await t.run(async (ctx) => {
        await seedTenantWithPermission(ctx);
        await addMembership(ctx, "m1", "t-p", "u1", status);
      });
      const decision = await t.run((ctx) =>
        evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
      );
      expect(decision).toMatchObject({ allowed: false, reasonCode, membershipId: "m1" });
    });
  }
});

// ── tenant-wide direct + group union ────────────────────────────────────────────
describe("evaluateAccess tenant-wide", () => {
  async function seedDirectGrant(ctx: SeedCtx): Promise<void> {
    await addSyncState(ctx);
    await addTenant(ctx, "t-p", { primary: true });
    await addMembership(ctx, "m1", "t-p", "u1");
    await addPermission(ctx, "perm-read", "app.doc:read");
    await addRole(ctx, "role-reader", { tenantId: "t-p" });
    await grant(ctx, "role-reader", "perm-read");
    await addUserRoleAssignment(ctx, "ura1", "t-p", "m1", "role-reader");
  }

  test("direct user role assignment grants", async () => {
    const t = harness();
    await t.run(seedDirectGrant);
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: true, reasonCode: "allowed", membershipId: "m1" });
  });

  test("a role lacking the permission denies with permission_denied", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-read", "app.doc:read");
      await addRole(ctx, "role-empty", { tenantId: "t-p" });
      await addUserRoleAssignment(ctx, "ura1", "t-p", "m1", "role-empty");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "permission_denied" });
  });

  test("permission held only via an ACTIVE group grants (user_* and group_* unioned)", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-read", "app.doc:read");
      await addRole(ctx, "role-reader", { tenantId: "t-p" });
      await grant(ctx, "role-reader", "perm-read");
      await addGroup(ctx, "g1", "t-p", "active");
      await addGroupMembership(ctx, "g1", "m1", "t-p");
      await addGroupRoleAssignment(ctx, "gra1", "t-p", "g1", "role-reader");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision.allowed).toBe(true);
  });

  test("a DISABLED group does not confer its role", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-read", "app.doc:read");
      await addRole(ctx, "role-reader", { tenantId: "t-p" });
      await grant(ctx, "role-reader", "perm-read");
      await addGroup(ctx, "g1", "t-p", "disabled");
      await addGroupMembership(ctx, "g1", "m1", "t-p");
      await addGroupRoleAssignment(ctx, "gra1", "t-p", "g1", "role-reader");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision.allowed).toBe(false);
  });
});

// ── expiry ──────────────────────────────────────────────────────────────────────
describe("evaluateAccess expiry", () => {
  async function seed(ctx: SeedCtx, expiresAt: number): Promise<void> {
    await addSyncState(ctx);
    await addTenant(ctx, "t-p", { primary: true });
    await addMembership(ctx, "m1", "t-p", "u1");
    await addPermission(ctx, "perm-read", "app.doc:read");
    await addRole(ctx, "role-reader", { tenantId: "t-p" });
    await grant(ctx, "role-reader", "perm-read");
    await addUserRoleAssignment(ctx, "ura1", "t-p", "m1", "role-reader", expiresAt);
  }

  test("an expired assignment is ignored (deny)", async () => {
    const t = harness();
    await t.run((ctx) => seed(ctx, Date.now() - 1_000));
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("a future expiry still grants (allow)", async () => {
    const t = harness();
    await t.run((ctx) => seed(ctx, Date.now() + 60_000));
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision.allowed).toBe(true);
  });
});

// ── default role is NOT implicitly applied ──────────────────────────────────────
describe("evaluateAccess default role", () => {
  test("tenant.defaultRoleId does not grant without an explicit assignment", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addPermission(ctx, "perm-read", "app.doc:read");
      await addRole(ctx, "role-default", { tenantId: "t-p" });
      await grant(ctx, "role-default", "perm-read");
      // The tenant names role-default as its default, but the membership holds
      // NO explicit assignment to it.
      await addTenant(ctx, "t-p", { primary: true, defaultRoleId: "role-default" });
      await addMembership(ctx, "m1", "t-p", "u1");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.doc:read" }),
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "permission_denied" });
  });
});

// ── app-scope app-wide authority ────────────────────────────────────────────────
describe("evaluateAccess app-scoped roles (app-wide)", () => {
  // Primary P + non-primary T. An app-scoped role held via P confers app-wide.
  async function seedBase(ctx: SeedCtx): Promise<void> {
    await addSyncState(ctx);
    await addTenant(ctx, "P", { primary: true });
    await addTenant(ctx, "T", { primary: false });
    await addMembership(ctx, "mP", "P", "u1");
    await addPermission(ctx, "perm-x", "app.x:do");
    await addRole(ctx, "role-app", { tenantId: null, isAppScope: true });
    await grant(ctx, "role-app", "perm-x");
    await addUserRoleAssignment(ctx, "uraP", "P", "mP", "role-app");
  }

  test("(a) app role via P authorizes in T even with an unrelated T membership", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedBase(ctx);
      await addMembership(ctx, "mT", "T", "u1"); // active, no X-granting role
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  test("(b) app role via P authorizes in T with NO T membership at all", async () => {
    const t = harness();
    await t.run(seedBase);
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  test("(c) a SHARED role (isAppScope=false) held only in P does NOT cross to T", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "P", { primary: true });
      await addTenant(ctx, "T", { primary: false });
      await addMembership(ctx, "mP", "P", "u1");
      await addPermission(ctx, "perm-x", "app.x:do");
      await addRole(ctx, "role-shared", { tenantId: null, isAppScope: false });
      await grant(ctx, "role-shared", "perm-x");
      await addUserRoleAssignment(ctx, "uraP", "P", "mP", "role-shared");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("(c2) a TENANT-SCOPED role held only in P does NOT cross to T", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "P", { primary: true });
      await addTenant(ctx, "T", { primary: false });
      await addMembership(ctx, "mP", "P", "u1");
      await addPermission(ctx, "perm-x", "app.x:do");
      await addRole(ctx, "role-p", { tenantId: "P", isAppScope: false });
      await grant(ctx, "role-p", "perm-x");
      await addUserRoleAssignment(ctx, "uraP", "P", "mP", "role-p");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("(d) when the target IS the primary tenant, the app role grants normally", async () => {
    const t = harness();
    await t.run(seedBase);
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "P",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision).toMatchObject({ allowed: true, membershipId: "mP" });
  });

  test("app role via P authorizes in T even when the T membership is blocked", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedBase(ctx);
      await addMembership(ctx, "mT", "T", "u1", "blocked");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "T",
        permissionKey: "app.x:do",
      }),
    );
    expect(decision.allowed).toBe(true);
  });
});

// ── resource ancestor walk ───────────────────────────────────────────────────────
describe("evaluateAccess resource scoping", () => {
  // A project (app.project) and a document (app.document) whose parent is the
  // project. resourceTypeIds: rt-project, rt-document.
  async function seedGraph(ctx: SeedCtx): Promise<void> {
    await addSyncState(ctx);
    await addTenant(ctx, "t-p", { primary: true });
    await addMembership(ctx, "m1", "t-p", "u1");
    await addPermission(ctx, "perm-edit", "app.document:edit");
    await addRole(ctx, "role-editor", { tenantId: "t-p" });
    await grant(ctx, "role-editor", "perm-edit");
    await addResourceType(ctx, "rt-project", "app.project", null);
    await addResourceType(ctx, "rt-document", "app.document", "rt-project");
    // project node p1, document node d1 whose parent is p1.
    await addResourceNode(ctx, "node-p1", "t-p", "rt-project", "p1");
    await addResourceNode(ctx, "node-d1", "t-p", "rt-document", "d1", "node-p1");
  }

  const request = (): AccessRequest => ({
    tokenIdentifier: token("u1"),
    permissionKey: "app.document:edit",
    resource: { type: "app.document", externalId: "d1" },
  });

  test("an assignment on the ancestor project grants on the child document", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedGraph(ctx);
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-project",
        "p1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(true);
  });

  test("an assignment on a different project denies", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedGraph(ctx);
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-project",
        "p2",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(false);
  });

  test("an assignment placed directly on the target grants without a node row", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-edit", "app.document:edit");
      await addRole(ctx, "role-editor", { tenantId: "t-p" });
      await grant(ctx, "role-editor", "perm-edit");
      await addResourceType(ctx, "rt-document", "app.document", null);
      // No resources node for d1 at all.
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-document",
        "d1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(true);
  });

  test("a dangling parent edge stops the walk (stale ancestor assignment does not grant)", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-edit", "app.document:edit");
      await addRole(ctx, "role-editor", { tenantId: "t-p" });
      await grant(ctx, "role-editor", "perm-edit");
      await addResourceType(ctx, "rt-project", "app.project", null);
      await addResourceType(ctx, "rt-document", "app.document", "rt-project");
      // d1 points at a parent node that does not exist.
      await addResourceNode(ctx, "node-d1", "t-p", "rt-document", "d1", "node-missing");
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-project",
        "p1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(false);
  });

  test("a cross-tenant parent edge is ignored (does not authorize)", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addTenant(ctx, "t-b", { primary: false });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-edit", "app.document:edit");
      await addRole(ctx, "role-editor", { tenantId: "t-p" });
      await grant(ctx, "role-editor", "perm-edit");
      await addResourceType(ctx, "rt-project", "app.project", null);
      await addResourceType(ctx, "rt-document", "app.document", "rt-project");
      // The parent node exists but lives in a DIFFERENT tenant.
      await addResourceNode(ctx, "node-pB", "t-b", "rt-project", "p1");
      await addResourceNode(ctx, "node-d1", "t-p", "rt-document", "d1", "node-pB");
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-project",
        "p1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(false);
  });

  test("a chain deeper than the depth cap stops before the far ancestor", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      await addPermission(ctx, "perm-do", "app.folder:do");
      await addRole(ctx, "role-editor", { tenantId: "t-p" });
      await grant(ctx, "role-editor", "perm-do");
      await addResourceType(ctx, "rt-folder", "app.folder", "rt-folder");
      // A 22-node chain: f0 (target) → f1 → … → f21 (top, beyond the cap of 20).
      for (let i = 0; i <= 21; i += 1) {
        await addResourceNode(
          ctx,
          `n${i}`,
          "t-p",
          "rt-folder",
          `f${i}`,
          i < 21 ? `n${i + 1}` : undefined,
        );
      }
      // Grant sits on the far ancestor f21, which the walk never reaches.
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-folder",
        "f21",
      );
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        permissionKey: "app.folder:do",
        resource: { type: "app.folder", externalId: "f0" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("an assignment with a mismatched resourceTypeId does not match the node", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedGraph(ctx);
      // Same externalId as the document (d1) but the wrong resource type.
      await addUserResourceRoleAssignment(
        ctx,
        "urra1",
        "t-p",
        "m1",
        "role-editor",
        "rt-project",
        "d1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(false);
  });

  test("a group resource assignment on an ancestor grants (group_* unioned in resource step)", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await seedGraph(ctx);
      await addGroup(ctx, "g1", "t-p", "active");
      await addGroupMembership(ctx, "g1", "m1", "t-p");
      await addGroupResourceRoleAssignment(
        ctx,
        "grra1",
        "t-p",
        "g1",
        "role-editor",
        "rt-project",
        "p1",
      );
    });
    const decision = await t.run((ctx) => evaluateAccess(ctx, request()));
    expect(decision.allowed).toBe(true);
  });
});

// ── cross-tenant isolation ───────────────────────────────────────────────────────
describe("evaluateAccess cross-tenant isolation", () => {
  test("a role held in tenant A never authorizes a request scoped to tenant B", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      // Primary tenant with NO caller membership, so app-scope never applies.
      await addTenant(ctx, "P", { primary: true });
      await addTenant(ctx, "A", { primary: false });
      await addTenant(ctx, "B", { primary: false });
      await addMembership(ctx, "mA", "A", "u1");
      await addMembership(ctx, "mB", "B", "u1");
      await addPermission(ctx, "perm-x", "app.x:do");
      await addRole(ctx, "role-a", { tenantId: "A" });
      await grant(ctx, "role-a", "perm-x");
      await addUserRoleAssignment(ctx, "uraA", "A", "mA", "role-a");
    });
    const allowInA = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "A",
        permissionKey: "app.x:do",
      }),
    );
    const denyInB = await t.run((ctx) =>
      evaluateAccess(ctx, {
        tokenIdentifier: token("u1"),
        tenantId: "B",
        permissionKey: "app.x:do",
      }),
    );
    expect(allowInA.allowed).toBe(true);
    expect(denyInB.allowed).toBe(false);
  });
});

// ── attach-time gate is NOT enforced at check time ───────────────────────────────
describe("evaluateAccess ignores permissions.isAppScope", () => {
  test("an app-scoped PERMISSION on a non-app-scoped role still evaluates off the role", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await addSyncState(ctx);
      await addTenant(ctx, "t-p", { primary: true });
      await addMembership(ctx, "m1", "t-p", "u1");
      // permission is app-scoped, but the engine must not read that flag.
      await addPermission(ctx, "perm-x", "app.x:do", true);
      await addRole(ctx, "role-plain", { tenantId: "t-p", isAppScope: false });
      await grant(ctx, "role-plain", "perm-x");
      await addUserRoleAssignment(ctx, "ura1", "t-p", "m1", "role-plain");
    });
    const decision = await t.run((ctx) =>
      evaluateAccess(ctx, { tokenIdentifier: token("u1"), permissionKey: "app.x:do" }),
    );
    expect(decision.allowed).toBe(true);
  });
});
