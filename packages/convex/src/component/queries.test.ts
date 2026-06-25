import { convexTest as baseConvexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  type ProjectionFixtureSnapshot,
  withProjectionFixtures,
} from "../../test/projection-fixtures";
import schema from "./schema";

// Compact semantic fixtures are materialized into the current projection wire
// shape before they reach the real applySync mutation.
type Snapshot = ProjectionFixtureSnapshot;

import { componentModules as modules } from "../../test/component-modules";

// Public-facing result shapes for the queries under test. Typing the function
// references with these makes `t.query(...)` results concrete (rather than `{}`),
// so the assertions below type-check without per-callback `any` annotations.
type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: string;
};
type TenantSummary = {
  tenantId: string;
  tenantName: string;
  kind: string;
  joinedAt: number;
  status: string;
  roles: RoleSummary[];
};
type PermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
};
type DirectRoleGrant = RoleSummary & {
  grantId: string;
  type: "role";
  expiresAt: number | null;
};
type TenantUser = {
  userId: string;
  status: string;
  joinedAt: number;
  name?: string;
  email?: string;
  roles: RoleSummary[];
  directRoleGrants: DirectRoleGrant[];
};
type TenantGroup = {
  groupId: string;
  status: string;
  joinedAt: number;
  memberCount: number;
  name?: string;
  roles: RoleSummary[];
  directRoleGrants: DirectRoleGrant[];
};
type TenantUsersPage = { users: TenantUser[]; cursor?: string };
type TenantGroupsPage = { groups: TenantGroup[]; cursor?: string };
type DirectSubjectsPage = { subjects: DirectSubject[]; cursor?: string };
type TenantDetail = {
  tenantId: string;
  tenantName: string;
  kind: string;
  status: string;
  accessMode: string;
  defaultRoleId: string;
  updatedAt: number;
};
type TenantRoleDetail = RoleSummary & {
  description: string | null;
  shared: boolean;
  basePermissions: Array<PermissionSummary & { effect: "allow" | "deny" }>;
  tenantOverrides: Array<PermissionSummary & { effect: "allow" | "deny" }>;
  effectivePermissions: PermissionSummary[];
};
type ResourcePermissionOverrides = {
  tenantId: string;
  subject:
    | { type: "user"; userId: string }
    | { type: "group"; groupId: string }
    | { type: "role"; roleId: string };
  resourceType: string;
  target: { type: "all" } | { type: "resource"; resourceId: string };
  grants: Array<{
    grantId: string;
    type: "permission";
    permissionId: string;
    permissionKey: string;
    effect: "allow" | "deny";
    appliesTo: "self" | "self_and_descendants";
    expiresAt: number | null;
  }>;
};
type AccessExplanation = {
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  decisiveReason: string;
  sources: {
    directGrants: Array<Record<string, unknown>>;
    groupMemberships: Array<Record<string, unknown>>;
    roles: Array<Record<string, unknown>>;
    roleOverrides: Array<Record<string, unknown>>;
    resourceGrants: Array<Record<string, unknown>>;
    ancestorGrants: Array<Record<string, unknown>>;
    explicitDenies: Array<Record<string, unknown>>;
    expiredIgnoredGrants: Array<Record<string, unknown>>;
  };
};
type DirectResourceRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};
type DirectResourcePermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};
type DirectSubject = {
  status: string;
  name?: string;
  email?: string;
  image?: string;
} & ({ type: "user"; userId: string } | { type: "group"; groupId: string }) &
  (
    | { grant: DirectResourceRoleGrant; role: RoleSummary }
    | { grant: DirectResourcePermissionGrant }
  );
type TenantAccessStatus =
  | {
      kind: "principal";
      principalId: string;
      status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
      stateVersion: number;
    }
  | {
      kind: "fallback";
      reason: string;
      stateVersion?: number;
    };

const applySync = makeFunctionReference<"mutation">("sync:applySync");
const getEffectivePermissions = makeFunctionReference<
  "query",
  Record<string, unknown>,
  { allowed: boolean; wildcard: string; permissions: string[] }
>("queries:getEffectivePermissions");
const listMyTenants = makeFunctionReference<
  "query",
  Record<string, unknown>,
  { tenants: TenantSummary[]; cursor?: string }
>("queries:listMyTenants");
const listMyRoles = makeFunctionReference<"query", Record<string, unknown>, RoleSummary[]>(
  "queries:listMyRoles",
);
const getTenant = makeFunctionReference<"query", Record<string, unknown>, TenantDetail | null>(
  "queries:getTenant",
);
const listTenantUsers = makeFunctionReference<"query", Record<string, unknown>, TenantUsersPage>(
  "queries:listTenantUsers",
);
const listTenantGroups = makeFunctionReference<"query", Record<string, unknown>, TenantGroupsPage>(
  "queries:listTenantGroups",
);
const listTenantRoles = makeFunctionReference<"query", Record<string, unknown>, RoleSummary[]>(
  "queries:listTenantRoles",
);
const getTenantRole = makeFunctionReference<
  "query",
  Record<string, unknown>,
  TenantRoleDetail | null
>("queries:getTenantRole");
const listGroupMembers = makeFunctionReference<"query", Record<string, unknown>, TenantUsersPage>(
  "queries:listGroupMembers",
);
const listUserGroups = makeFunctionReference<"query", Record<string, unknown>, TenantGroupsPage>(
  "queries:listUserGroups",
);
const getResourcePermissionOverrides = makeFunctionReference<
  "query",
  Record<string, unknown>,
  ResourcePermissionOverrides | null
>("queries:getResourcePermissionOverrides");
const explainAccess = makeFunctionReference<
  "query",
  Record<string, unknown>,
  AccessExplanation | null
>("queries:explainAccess");
const authorize = makeFunctionReference<
  "query",
  Record<string, unknown>,
  { allowed: boolean; reasonCode: string; explicitDeny: boolean }
>("checks:authorize");
const listTenantPermissions = makeFunctionReference<
  "query",
  Record<string, unknown>,
  PermissionSummary[]
>("queries:listTenantPermissions");
const listDirectSubjectsForResource = makeFunctionReference<
  "query",
  Record<string, unknown>,
  DirectSubjectsPage
>("queries:listDirectSubjectsForResource");
const getTenantAccessStatus = makeFunctionReference<
  "query",
  Record<string, unknown>,
  TenantAccessStatus
>("queries:getTenantAccessStatus");

const ISSUER = "https://auth.example.com";
const convexTest = (schemaArg: typeof schema, modulesArg: typeof modules) =>
  withProjectionFixtures(baseConvexTest(schemaArg, modulesArg));

function emptyState() {
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

async function seedTenantAccessMirror(
  t: ReturnType<typeof convexTest>,
  options: {
    sourceVersion: number;
    principal?: {
      id: string;
      type: "user" | "group";
      authUserId: string;
      status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
    };
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("sync_state", {
      sourceVersion: options.sourceVersion,
      expectedIssuer: ISSUER,
      lastSyncedAt: 1,
    });
    await ctx.db.insert("scopes", {
      accessScopeId: "scope_default",
      name: "App",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
      sourceVersion: options.sourceVersion,
    });
    if (options.principal) {
      await ctx.db.insert("principals", {
        accessScopeId: "scope_default",
        principalId: options.principal.id,
        type: options.principal.type,
        herculesAuthUserId: options.principal.authUserId,
        memberCount: 0,
        status: options.principal.status,
        joinedAt: 1,
        updatedAt: 1,
        sourceVersion: options.sourceVersion,
      });
    }
  });
}

describe("getTenantAccessStatus", () => {
  test.each(["active", "blocked", "suspended", "pending_approval", "removed"] as const)(
    "returns the default-scope principal's %s status from the mirror",
    async (status) => {
      const t = convexTest(schema, modules);
      await seedTenantAccessMirror(t, {
        sourceVersion: 7,
        principal: {
          id: "principal_1",
          type: "user",
          authUserId: "user_1",
          status,
        },
      });

      await expect(
        t.query(getTenantAccessStatus, {
          tokenIdentifier: `${ISSUER}|user_1`,
        }),
      ).resolves.toEqual({
        kind: "principal",
        principalId: "principal_1",
        status,
        stateVersion: 7,
      });
    },
  );

  test("falls back when the default tenant has no user principal", async () => {
    const t = convexTest(schema, modules);
    await seedTenantAccessMirror(t, { sourceVersion: 3 });

    await expect(
      t.query(getTenantAccessStatus, {
        tokenIdentifier: `${ISSUER}|new_user`,
      }),
    ).resolves.toEqual({
      kind: "fallback",
      reason: "principal_missing",
      stateVersion: 3,
    });
  });

  test("never treats a malformed group principal as the signed-in user", async () => {
    const t = convexTest(schema, modules);
    await seedTenantAccessMirror(t, {
      sourceVersion: 4,
      principal: {
        id: "group_1",
        type: "group",
        authUserId: "user_1",
        status: "active",
      },
    });

    await expect(
      t.query(getTenantAccessStatus, {
        tokenIdentifier: `${ISSUER}|user_1`,
      }),
    ).resolves.toEqual({
      kind: "fallback",
      reason: "principal_missing",
      stateVersion: 4,
    });
  });

  test("falls back before the deployment mirror is initialized", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.query(getTenantAccessStatus, {
        tokenIdentifier: `${ISSUER}|user_1`,
      }),
    ).resolves.toEqual({
      kind: "fallback",
      reason: "mirror_not_ready",
    });
  });
});

function memberSnapshot(
  tenantId: string,
  scopeName: string,
  scopeKind: "default" | "org",
  scopeStatus: "active" | "disabled",
  options: {
    userPrincipalId: string;
    roleId: string;
    grantId: string;
    sourceVersion: number;
    eventId: string;
  },
): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: options.eventId,
    sourceVersion: options.sourceVersion,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: tenantId,
      name: scopeName,
      kind: scopeKind,
      status: scopeStatus,
      accessMode: "open",
      defaultRoleId: options.roleId,
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [
        {
          principalId: options.userPrincipalId,
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 1000 + options.sourceVersion,
          updatedAt: 1000 + options.sourceVersion,
        },
      ],
      roles: [
        {
          roleId: options.roleId,
          accessScopeId: tenantId,
          key: scopeKind === "default" ? "owner" : "admin",
          kind: "system",
          name: scopeKind === "default" ? "Owner" : "Admin",
          wildcard: scopeKind === "default" ? "immutable" : "default",
          updatedAt: 1,
        },
      ],
      grants: [
        {
          grantId: options.grantId,
          subjectPrincipalId: options.userPrincipalId,
          relationKind: "role",
          roleId: options.roleId,
          effect: "allow",
          objectType: "scope",
          objectId: tenantId,
          updatedAt: 1,
        },
      ],
    },
  };
}

function effectiveRoleReadSnapshot(options: {
  grants: Snapshot["state"]["grants"];
  roles: Snapshot["state"]["roles"];
  // The group principal's status. Defaults to "active"; the blocked-group fence
  // tests (E3 / L9) pass "blocked" to assert the group confers nothing.
  groupStatus?: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
}): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_effective_role_reads",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [
        {
          principalId: "p_alice",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 1001,
          updatedAt: 1,
        },
        {
          principalId: "p_engineering",
          type: "group",
          status: options.groupStatus ?? "active",
          joinedAt: 1000,
          updatedAt: 1,
        },
      ],
      principalMemberships: [
        {
          groupPrincipalId: "p_engineering",
          memberPrincipalId: "p_alice",
          updatedAt: 1,
        },
      ],
      roles: options.roles,
      grants: options.grants,
    },
  };
}

// The engineer role conferred onto the engineering group, shared by the
// group-conferral and blocked-group fence tests.
const engineerRole = {
  roleId: "role_engineer",
  accessScopeId: "scope_acme",
  key: "engineer",
  kind: "custom" as const,
  name: "Engineer",
  wildcard: "none" as const,
  updatedAt: 1,
};
const engineerGroupGrant = {
  grantId: "grant_engineering_engineer",
  subjectPrincipalId: "p_engineering",
  relationKind: "role" as const,
  roleId: "role_engineer",
  effect: "allow" as const,
  objectType: "scope" as const,
  objectId: "scope_acme",
  updatedAt: 1,
};

describe("listMyTenants", () => {
  test("returns memberships across multiple active tenants", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );
    await t.mutation(
      applySync,
      memberSnapshot("scope_acme", "Acme", "org", "active", {
        userPrincipalId: "p_alice_acme",
        roleId: "role_acme_admin",
        grantId: "grant_alice_acme",
        sourceVersion: 2,
        eventId: "evt_acme",
      }),
    );

    const firstPage = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      limit: 1,
    });
    expect(firstPage.tenants).toHaveLength(1);
    expect(firstPage.cursor).toEqual(expect.any(String));
    const secondPage = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      limit: 1,
      cursor: firstPage.cursor,
    });
    const memberships = [...firstPage.tenants, ...secondPage.tenants];

    expect(memberships).toHaveLength(2);
    const byTenant = new Map(memberships.map((tenant) => [tenant.tenantId, tenant]));
    expect(byTenant.get("scope_default")?.roles[0]?.roleKey).toBe("owner");
    expect(byTenant.get("scope_default")?.kind).toBe("default");
    expect(byTenant.get("scope_acme")?.roles[0]?.roleKey).toBe("admin");
    expect(byTenant.get("scope_acme")?.kind).toBe("custom");
    expect(byTenant.get("scope_default")?.joinedAt).toBe(1001);
    expect(byTenant.get("scope_acme")?.joinedAt).toBe(1002);
  });

  test("returns all roles for a membership in one scope", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, {
      type: "access.projection.snapshot",
      eventId: "evt_multi_role",
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_acme",
        name: "Acme",
        kind: "org",
        status: "active",
        accessMode: "open",
        defaultRoleId: "role_loan_officer",
        updatedAt: 1,
      },
      state: {
        ...emptyState(),
        principals: [
          {
            principalId: "p_alice_acme",
            type: "user",
            herculesAuthUserId: "user_alice",
            status: "active",
            joinedAt: 1001,
            updatedAt: 1001,
          },
        ],
        roles: [
          {
            roleId: "role_loan_officer",
            accessScopeId: "scope_acme",
            key: "loan_officer",
            kind: "custom",
            name: "Loan Officer",
            wildcard: "none",
            updatedAt: 1,
          },
          {
            roleId: "role_field_agent",
            accessScopeId: "scope_acme",
            key: "field_agent",
            kind: "custom",
            name: "Field Agent",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        grants: [
          {
            grantId: "grant_alice_loan_officer",
            subjectPrincipalId: "p_alice_acme",
            relationKind: "role",
            roleId: "role_loan_officer",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
          {
            grantId: "grant_alice_field_agent",
            subjectPrincipalId: "p_alice_acme",
            relationKind: "role",
            roleId: "role_field_agent",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_acme",
            updatedAt: 1,
          },
        ],
      },
    } satisfies Snapshot);

    const { tenants: memberships } = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      tenantId: "scope_acme",
      roles: [
        {
          roleId: "role_field_agent",
          roleKey: "field_agent",
          roleName: "Field Agent",
        },
        {
          roleId: "role_loan_officer",
          roleKey: "loan_officer",
          roleName: "Loan Officer",
        },
      ],
    });
  });

  test("includes an active resource-only user with no tenant roles", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(applySync, {
      type: "access.projection.snapshot",
      eventId: "evt_resource_only_tenant",
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_acme",
        name: "Acme",
        kind: "org",
        status: "active",
        accessMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 1,
      },
      state: {
        ...emptyState(),
        principals: [
          {
            principalId: "p_alice_acme",
            type: "user",
            herculesAuthUserId: "user_alice",
            status: "active",
            joinedAt: 1001,
            updatedAt: 1001,
          },
        ],
        permissions: [
          {
            permissionId: "perm_docs_read",
            accessScopeId: "scope_default",
            key: "app.docs:read",
            resourceType: "app.docs",
            action: "read",
            tenantAssignable: true,
            updatedAt: 1,
          },
        ],
        grants: [
          {
            grantId: "grant_alice_doc",
            subjectPrincipalId: "p_alice_acme",
            relationKind: "direct_permission",
            permissionId: "perm_docs_read",
            effect: "allow",
            objectType: "resource",
            objectResourceType: "app.docs",
            objectId: "doc_1",
            updatedAt: 1,
          },
        ],
      },
    } satisfies Snapshot);

    await expect(
      t
        .query(listMyTenants, {
          tokenIdentifier: `${ISSUER}|user_alice`,
        })
        .then((page) => page.tenants),
    ).resolves.toEqual([
      {
        tenantId: "scope_acme",
        tenantName: "Acme",
        kind: "custom",
        roles: [],
        joinedAt: 1001,
        status: "active",
      },
    ]);
  });

  test("lists roles for one scope", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_acme", "Acme", "org", "active", {
        userPrincipalId: "p_alice_acme",
        roleId: "role_acme_admin",
        grantId: "grant_alice_acme",
        sourceVersion: 1,
        eventId: "evt_acme",
      }),
    );

    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(roles).toEqual([
      {
        roleId: "role_acme_admin",
        roleKey: "admin",
        roleName: "Admin",
        roleKind: "system",
      },
    ]);
  });

  test("lists roles inherited through direct group membership", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      effectiveRoleReadSnapshot({
        roles: [engineerRole],
        grants: [engineerGroupGrant],
      }),
    );

    const { tenants: memberships } = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });
    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(memberships[0]?.roles).toEqual([
      {
        roleId: "role_engineer",
        roleKey: "engineer",
        roleName: "Engineer",
        roleKind: "custom",
      },
    ]);
    expect(roles).toEqual(memberships[0]?.roles);
  });

  // L9 (consumer-plane blocked-group fence): collectPrincipalScopeRoles must share
  // the E3 fence — a membership whose group principal is NOT active confers
  // nothing. Without the fence, the member would inherit the engineer role through
  // a blocked group.
  test("a blocked group confers no roles through membership", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      applySync,
      effectiveRoleReadSnapshot({
        roles: [engineerRole],
        grants: [engineerGroupGrant],
        groupStatus: "blocked",
      }),
    );

    const roles = await t.query(listMyRoles, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(roles).toEqual([]);
  });

  // NOTE: the v2-era "role deny overrides direct and group role allows" test was
  // removed. v4 role_bindings are additive-only (no `effect` column), so a role
  // can no longer be subtracted from a principal by a deny role binding. Role
  // membership listing for the additive case is covered by the surrounding
  // listMyTenants / listMyRoles tests.

  test("skips disabled scopes", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );
    await t.mutation(
      applySync,
      memberSnapshot("scope_archived", "Archived", "org", "disabled", {
        userPrincipalId: "p_alice_archived",
        roleId: "role_archived_admin",
        grantId: "grant_alice_archived",
        sourceVersion: 2,
        eventId: "evt_archived",
      }),
    );

    const { tenants: memberships } = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.tenantId).toBe("scope_default");
  });

  test("returns empty list when user has no principals", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_other",
        roleId: "role_owner",
        grantId: "grant_other",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );

    const { tenants: memberships } = await t.query(listMyTenants, {
      tokenIdentifier: `${ISSUER}|user_unknown`,
    });
    expect(memberships).toEqual([]);
  });

  test("returns empty when sync_state issuer does not match", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(
      applySync,
      memberSnapshot("scope_default", "Default", "default", "active", {
        userPrincipalId: "p_alice_default",
        roleId: "role_owner",
        grantId: "grant_alice_default",
        sourceVersion: 1,
        eventId: "evt_default",
      }),
    );

    const { tenants: memberships } = await t.query(listMyTenants, {
      tokenIdentifier: "https://other.example.com|user_alice",
    });
    expect(memberships).toEqual([]);
  });
});

describe("getEffectivePermissions", () => {
  test("applies explicit role denies across all assigned roles", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, permissionCatalogSnapshot());
    await t.mutation(applySync, permissionOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(result).toMatchObject({
      allowed: true,
      reasonCode: "allowed",
      sourceVersion: 2,
      principalId: "p_alice_acme",
      tenantId: "scope_acme",
      effectiveRoleIds: ["role_manager", "role_accountant", "role_field_agent"],
      permissions: ["borrowers.create"],
    });
  });

  test("only includes resource grants for the requested resource", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    const withoutResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });
    expect(withoutResource.permissions).toEqual(["system.access.grants:read"]);

    const withResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(withResource.permissions).toEqual(["reports.read", "system.access.grants:read"]);

    const otherResource = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_456",
    });
    expect(otherResource.permissions).toEqual(["system.access.grants:read"]);
  });

  test("applies a role-wide resource allow with a specific deny exception", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceRoleCatalogSnapshot());
    await t.mutation(applySync, resourceRoleOrgSnapshot());

    const ordinaryReport = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(ordinaryReport.permissions).toEqual(["reports.read"]);

    const blockedReport = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_private",
    });
    expect(blockedReport.permissions).toEqual([]);
  });

  test("does not authorize a resource rule for a missing role", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceRoleOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });
    expect(result.permissions).toEqual([]);
  });

  test("expands manage/* grants to concrete verbs without advertising superset keys", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, manageCatalogSnapshot());
    await t.mutation(applySync, manageOrgSnapshot());

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    // L-3: superset-action catalog keys (`:manage`, `:*`) are control-plane
    // management gates; authorize() rejects a request that resolves to one with
    // `invalid_request`, so getEffectivePermissions must not advertise them.
    // The grants still expand onto the concrete-verb catalog keys they cover.
    expect(result.wildcard).toBe("none");
    expect(result.permissions).toEqual(["system.access.roles:read", "system.reports:export"]);
  });

  // Runtime-plane group conferral: a member inherits the permissions of a role
  // bound to an ACTIVE group it belongs to (evaluateEffectiveAccess via the
  // E3-fenced collectPrincipalIds).
  test("a member inherits a permission through an active group", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, groupPermissionCatalogSnapshot());
    await t.mutation(applySync, groupPermissionOrgSnapshot("active"));

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(result).toMatchObject({
      allowed: true,
      effectiveRoleIds: ["role_engineer"],
      permissions: ["deploys.run"],
    });
  });

  // E3 (runtime-plane blocked-group fence): a member inherits NOTHING when the
  // group principal is blocked. Without the fence the member would still gain the
  // group's permission.
  test("a blocked group confers no permission at runtime", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, groupPermissionCatalogSnapshot());
    await t.mutation(applySync, groupPermissionOrgSnapshot("blocked"));

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(result).toMatchObject({
      allowed: true,
      effectiveRoleIds: [],
      permissions: [],
    });
  });

  // Same E3 fence for the MANUAL eviction state: a removed group must confer
  // nothing, exactly like a blocked one.
  test("a removed group confers no permission at runtime", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, groupPermissionCatalogSnapshot());
    await t.mutation(applySync, groupPermissionOrgSnapshot("removed"));

    const result = await t.query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
    });

    expect(result).toMatchObject({
      allowed: true,
      effectiveRoleIds: [],
      permissions: [],
    });
  });
});

// H2 cross-scope fence: org-scope evaluations also require an ACTIVE user
// principal in the default (app) scope, so each catalog fixture below seeds
// alice's app-scope standing alongside the deployment-wide catalog.
const aliceAppPrincipal = {
  principalId: "p_alice_app",
  type: "user",
  herculesAuthUserId: "user_alice",
  status: "active",
  joinedAt: 100,
  updatedAt: 100,
};

function groupPermissionCatalogSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_group_permission_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [aliceAppPrincipal],
      permissions: [
        {
          permissionId: "perm_deploys_run",
          accessScopeId: "scope_default",
          key: "deploys.run",
          resourceType: "deploys",
          action: "run",
          tenantAssignable: true,
          updatedAt: 1,
        },
      ],
    },
  };
}

function groupPermissionOrgSnapshot(
  groupStatus: "active" | "blocked" | "suspended" | "pending_approval" | "removed",
): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_group_permission_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_engineer",
      updatedAt: 2,
    },
    state: {
      ...emptyState(),
      principals: [
        {
          principalId: "p_alice_acme",
          type: "user",
          herculesAuthUserId: "user_alice",
          status: "active",
          joinedAt: 100,
          updatedAt: 100,
        },
        {
          principalId: "p_engineering",
          type: "group",
          status: groupStatus,
          joinedAt: 100,
          updatedAt: 100,
        },
      ],
      principalMemberships: [
        {
          groupPrincipalId: "p_engineering",
          memberPrincipalId: "p_alice_acme",
          updatedAt: 2,
        },
      ],
      roles: [
        {
          roleId: "role_engineer",
          accessScopeId: "scope_acme",
          key: "engineer",
          kind: "custom",
          name: "Engineer",
          wildcard: "none",
          updatedAt: 2,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_engineer",
          permissionId: "perm_deploys_run",
          accessScopeId: "scope_acme",
          effect: "allow",
          updatedAt: 2,
        },
      ],
      grants: [
        {
          grantId: "grant_engineering_engineer",
          subjectPrincipalId: "p_engineering",
          relationKind: "role",
          roleId: "role_engineer",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
      ],
    },
  };
}

function manageCatalogSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_manage_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [aliceAppPrincipal],
      permissions: [
        {
          permissionId: "perm_roles_manage",
          accessScopeId: "scope_default",
          key: "system.access.roles:manage",
          resourceType: "system.access.roles",
          action: "manage",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_roles_read",
          accessScopeId: "scope_default",
          key: "system.access.roles:read",
          resourceType: "system.access.roles",
          action: "read",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_reports_all",
          accessScopeId: "scope_default",
          key: "system.reports:*",
          resourceType: "system.reports",
          action: "*",
          tenantAssignable: true,
          updatedAt: 1,
        },
        {
          permissionId: "perm_reports_export",
          accessScopeId: "scope_default",
          key: "system.reports:export",
          resourceType: "system.reports",
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
    },
  };
}

function manageOrgSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_manage_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_role_admin",
      updatedAt: 2,
    },
    state: {
      ...emptyState(),
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
      roles: [
        {
          roleId: "role_role_admin",
          accessScopeId: "scope_acme",
          key: "role_admin",
          kind: "custom",
          name: "Role Admin",
          wildcard: "none",
          updatedAt: 2,
        },
      ],
      rolePermissions: [
        {
          roleId: "role_role_admin",
          permissionId: "perm_roles_manage",
          accessScopeId: "scope_acme",
          effect: "allow",
          updatedAt: 2,
        },
        {
          roleId: "role_role_admin",
          permissionId: "perm_reports_all",
          accessScopeId: "scope_acme",
          effect: "allow",
          updatedAt: 2,
        },
      ],
      grants: [
        {
          grantId: "grant_alice_role_admin",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_role_admin",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
      ],
    },
  };
}

function permissionCatalogSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_permission_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_manager",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [aliceAppPrincipal],
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
        {
          permissionId: "perm_borrowers_create",
          accessScopeId: "scope_default",
          key: "borrowers.create",
          resourceType: "borrowers",
          action: "create",
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

function permissionOrgSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_permission_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_manager",
      updatedAt: 2,
    },
    state: {
      ...emptyState(),
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
        {
          grantId: "grant_alice_borrowers_create_allow",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_borrowers_create",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
      ],
    },
  };
}

function resourceCatalogSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_resource_catalog",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
      principals: [aliceAppPrincipal],
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
        {
          permissionId: "perm_grants_read",
          accessScopeId: "scope_default",
          key: "system.access.grants:read",
          resourceType: "system.access.grants",
          action: "read",
          tenantAssignable: false,
          updatedAt: 1,
        },
      ],
    },
  };
}

function resourceOrgSnapshot(): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_resource_org",
    sourceVersion: 2,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_acme",
      name: "Acme",
      kind: "org",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 2,
    },
    state: {
      ...emptyState(),
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
      grants: [
        {
          grantId: "grant_alice_grants_read",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_grants_read",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_alice_report_123_read",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "allow",
          objectType: "resource",
          objectId: "report_123",
          objectResourceType: "reports",
          updatedAt: 2,
        },
      ],
    },
  };
}

function resourceRoleCatalogSnapshot(): Snapshot {
  const snapshot = resourceCatalogSnapshot();
  return {
    ...snapshot,
    eventId: "evt_resource_role_catalog",
    state: {
      ...snapshot.state,
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
    },
  };
}

function resourceRoleOrgSnapshot(): Snapshot {
  const snapshot = resourceOrgSnapshot();
  return {
    ...snapshot,
    eventId: "evt_resource_role_org",
    state: {
      ...snapshot.state,
      grants: [
        {
          grantId: "grant_alice_viewer",
          subjectPrincipalId: "p_alice_acme",
          relationKind: "role",
          roleId: "role_viewer",
          effect: "allow",
          objectType: "scope",
          objectId: "scope_acme",
          updatedAt: 2,
        },
        {
          grantId: "grant_viewer_reports_read",
          subjectRoleId: "role_viewer",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "allow",
          objectType: "resource",
          objectId: "*",
          objectResourceType: "reports",
          updatedAt: 2,
        },
        {
          grantId: "grant_viewer_private_report_block",
          subjectRoleId: "role_viewer",
          relationKind: "direct_permission",
          permissionId: "perm_reports_read",
          effect: "deny",
          objectType: "resource",
          objectId: "report_private",
          objectResourceType: "reports",
          updatedAt: 2,
        },
      ],
    },
  };
}

// A resource share grant as the producer projects it — IDENTICAL in shape
// whether it originated from an accepted resource invitation or an immediate
// resource grant (both resolve to one principal-subject, resource-object,
// direct_permission grant). The component only sees the projected row, so
// getEffectivePermissions must enumerate the same permission set for both.
type ResourceShareGrant = {
  grantId: string;
  effect: "allow" | "deny";
  objectId: string;
  objectResourceType?: string;
};

// The permission catalog is app-wide and always lives in the DEFAULT scope
// (effective.ts fetches catalogPermissions there). Seed the permission, the
// principal, the Viewer role membership, and the resource grants all in the
// default scope so getEffectivePermissions can enumerate over the catalog.
function resourceShareEnumSnapshot(grants: ResourceShareGrant[]): Snapshot {
  return {
    type: "access.projection.snapshot",
    eventId: "evt_resource_share_enum",
    sourceVersion: 1,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_viewer",
      updatedAt: 1,
    },
    state: {
      ...emptyState(),
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

function effectiveReportPermissions(
  t: ReturnType<typeof convexTest>,
  resourceId: string,
): Promise<string[]> {
  return t
    .query(getEffectivePermissions, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_default",
      resourceType: "reports",
      resourceId,
    })
    .then((result) => result.permissions);
}

// getEffectivePermissions must enumerate IDENTICALLY for a permission reached
// via an accepted resource invitation vs an equivalent immediate resource
// grant: same projected row, same enumerated set.
describe("getEffectivePermissions — resource invitation / immediate grant parity", () => {
  test("ordinary resource share allow enumerates identically for both origins", async () => {
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
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
      resourceShareEnumSnapshot([
        {
          grantId: "grant_invitation",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );

    const fromImmediate = await effectiveReportPermissions(immediate, "report_1");
    const fromInvitation = await effectiveReportPermissions(invitation, "report_1");
    expect(fromImmediate).toEqual(["reports.read"]);
    expect(fromInvitation).toEqual(fromImmediate);
  });

  test("an inherited deny overrides the resource share identically for both origins", async () => {
    // A scope-wide all-instances ("*") deny overrides the instance allow.
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
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
      resourceShareEnumSnapshot([
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

    const fromImmediate = await effectiveReportPermissions(immediate, "report_1");
    const fromInvitation = await effectiveReportPermissions(invitation, "report_1");
    expect(fromImmediate).toEqual([]);
    expect(fromInvitation).toEqual(fromImmediate);
  });

  test("a malformed-resourceType grant enumerates nothing for both origins", async () => {
    const immediate = convexTest(schema, modules);
    await immediate.mutation(
      applySync,
      resourceShareEnumSnapshot([
        { grantId: "grant_immediate", effect: "allow", objectId: "report_1" },
      ]),
    );
    const invitation = convexTest(schema, modules);
    await invitation.mutation(
      applySync,
      resourceShareEnumSnapshot([
        { grantId: "grant_invitation", effect: "allow", objectId: "report_1" },
      ]),
    );

    const fromImmediate = await effectiveReportPermissions(immediate, "report_1");
    const fromInvitation = await effectiveReportPermissions(invitation, "report_1");
    expect(fromImmediate).toEqual([]);
    expect(fromInvitation).toEqual(fromImmediate);

    // Positive control: same shape with a well-formed resourceType enumerates
    // the permission, so the empty sets above are attributable to the malformed
    // type alone.
    const wellFormed = convexTest(schema, modules);
    await wellFormed.mutation(
      applySync,
      resourceShareEnumSnapshot([
        {
          grantId: "grant_well_formed",
          effect: "allow",
          objectId: "report_1",
          objectResourceType: "reports",
        },
      ]),
    );
    expect(await effectiveReportPermissions(wellFormed, "report_1")).toEqual(["reports.read"]);
  });
});

describe("tenant admin reads", () => {
  // Default tenant with the system read permissions in the catalog, an Owner
  // (immutable wildcard, so it passes any read gate), and a plain Member
  // (no permissions). The catalog must contain the gated key or the gate
  // denies, so the read permissions are seeded explicitly.
  function adminReadSnapshot(): Snapshot {
    return {
      type: "access.projection.snapshot",
      eventId: "evt_admin_read",
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      scope: {
        accessScopeId: "scope_default",
        name: "Default",
        kind: "default",
        status: "active",
        accessMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 1,
      },
      state: {
        ...emptyState(),
        users: [
          {
            herculesAuthUserId: "user_owner",
            name: "Olivia Owner",
            email: "olivia@example.com",
            emailVerified: true,
            phoneVerified: false,
            updatedAt: 1,
          },
          {
            herculesAuthUserId: "user_member",
            name: "Mia Member",
            email: "mia@example.com",
            emailVerified: true,
            phoneVerified: false,
            updatedAt: 1,
          },
        ],
        permissions: [
          {
            permissionId: "perm_members_read",
            accessScopeId: "scope_default",
            key: "system.access.users:read",
            resourceType: "system.access.users",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_roles_read",
            accessScopeId: "scope_default",
            key: "system.access.roles:read",
            resourceType: "system.access.roles",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_permissions_read",
            accessScopeId: "scope_default",
            key: "system.access.permissions:read",
            resourceType: "system.access.permissions",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_grants_read",
            accessScopeId: "scope_default",
            key: "system.access.grants:read",
            resourceType: "system.access.grants",
            action: "read",
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_posts_read",
            accessScopeId: "scope_default",
            key: "posts:read",
            resourceType: "posts",
            action: "read",
            tenantAssignable: true,
            updatedAt: 1,
          },
        ],
        roles: [
          {
            roleId: "role_owner",
            accessScopeId: "scope_default",
            key: "owner",
            kind: "system",
            name: "Owner",
            description: "Full tenant access.",
            wildcard: "immutable",
            updatedAt: 1,
          },
          {
            roleId: "role_member",
            accessScopeId: "scope_default",
            key: "member",
            kind: "system",
            name: "Member",
            description: "Default tenant member access.",
            wildcard: "none",
            updatedAt: 1,
          },
        ],
        rolePermissions: [
          {
            roleId: "role_member",
            permissionId: "perm_posts_read",
            accessScopeId: "scope_default",
            effect: "allow",
            updatedAt: 1,
          },
        ],
        principals: [
          {
            principalId: "p_owner",
            type: "user",
            herculesAuthUserId: "user_owner",
            status: "active",
            joinedAt: 1001,
            updatedAt: 1001,
          },
          {
            principalId: "p_member",
            type: "user",
            herculesAuthUserId: "user_member",
            status: "active",
            joinedAt: 1002,
            updatedAt: 1002,
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

  test("owner lists users with roles; unprivileged user gets an empty list", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    const asOwner = await t.query(listTenantUsers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });
    expect(asOwner.users.map((user) => user.userId).sort()).toEqual(["user_member", "user_owner"]);
    const owner = asOwner.users.find((user) => user.userId === "user_owner");
    expect(owner?.name).toBe("Olivia Owner");
    expect(owner?.roles[0]?.roleKey).toBe("owner");
    expect(owner?.directRoleGrants).toEqual([
      {
        grantId: "grant_owner",
        type: "role",
        roleId: "role_owner",
        roleKey: "owner",
        roleName: "Owner",
        roleKind: "system",
        expiresAt: null,
      },
    ]);

    const asMember = await t.query(listTenantUsers, {
      tokenIdentifier: `${ISSUER}|user_member`,
      tenantId: "scope_default",
    });
    expect(asMember).toEqual({ users: [] });
  });

  test("returns tenant metadata and paginates users at the requested bound", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    await expect(
      t.query(getTenant, {
        tokenIdentifier: `${ISSUER}|user_owner`,
        tenantId: "scope_default",
      }),
    ).resolves.toEqual({
      tenantId: "scope_default",
      tenantName: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 1,
    });

    const firstPage = await t.query(listTenantUsers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      limit: 1,
    });
    expect(firstPage.users).toHaveLength(1);
    expect(firstPage.cursor).toEqual(expect.any(String));

    const secondPage = await t.query(listTenantUsers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(secondPage.users).toHaveLength(1);
    expect(new Set([...firstPage.users, ...secondPage.users].map((user) => user.userId))).toEqual(
      new Set(["user_owner", "user_member"]),
    );

    await expect(
      t.query(listTenantUsers, {
        tokenIdentifier: `${ISSUER}|user_owner`,
        tenantId: "scope_default",
        limit: 101,
      }),
    ).rejects.toThrow("listTenantUsers limit must be an integer from 1 to 100");
  });

  test("returns role description, base rows, tenant overrides, and net permissions", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());
    await t.run(async (ctx) => {
      await ctx.db.insert("role_permission_overrides", {
        accessScopeId: "scope_default",
        roleId: "role_member",
        permissionId: "perm_posts_read",
        effect: "deny",
        updatedAt: 2,
        sourceVersion: 1,
      });
    });

    await expect(
      t.query(getTenantRole, {
        tokenIdentifier: `${ISSUER}|user_owner`,
        tenantId: "scope_default",
        roleId: "role_member",
      }),
    ).resolves.toEqual({
      roleId: "role_member",
      roleKey: "member",
      roleName: "Member",
      roleKind: "system",
      description: "Default tenant member access.",
      shared: false,
      basePermissions: [
        expect.objectContaining({
          permissionId: "perm_posts_read",
          key: "posts:read",
          effect: "allow",
        }),
      ],
      tenantOverrides: [
        expect.objectContaining({
          permissionId: "perm_posts_read",
          key: "posts:read",
          effect: "deny",
        }),
      ],
      effectivePermissions: [],
    });
  });

  test("owner lists roles and the permission catalog; member is denied both", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    const roles = await t.query(listTenantRoles, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });
    expect(roles.map((r) => r.roleKey).sort()).toEqual(["member", "owner"]);

    const permissions = await t.query(listTenantPermissions, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });
    expect(permissions.map((p) => p.key)).toContain("posts:read");
    expect(permissions.map((p) => p.key)).toContain("system.access.users:read");

    expect(
      await t.query(listTenantRoles, {
        tokenIdentifier: `${ISSUER}|user_member`,
        tenantId: "scope_default",
      }),
    ).toEqual([]);
    expect(
      await t.query(listTenantPermissions, {
        tokenIdentifier: `${ISSUER}|user_member`,
        tenantId: "scope_default",
      }),
    ).toEqual([]);
  });

  test("labels only system-source roles as system", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", {
        roleId: "role_editor",
        key: "editor",
        source: "iam",
        name: "Editor",
        description: null,
        baseWildcard: "none",
        updatedAt: 2,
        sourceVersion: 1,
      });
    });

    const roles = await t.query(listTenantRoles, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });

    expect(roles.find((role) => role.roleId === "role_owner")?.roleKind).toBe("system");
    expect(roles.find((role) => role.roleId === "role_editor")?.roleKind).toBe("custom");
  });

  test("explainAccess uses the authorize evaluator and reports decisive sources", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());
    await t.run(async (ctx) => {
      await ctx.db.insert("principals", {
        accessScopeId: "scope_default",
        principalId: "p_reviewers",
        type: "group",
        name: "Reviewers",
        memberCount: 0,
        status: "active",
        joinedAt: 1,
        updatedAt: 1,
        sourceVersion: 1,
      });
      await ctx.db.insert("principal_memberships", {
        accessScopeId: "scope_default",
        groupPrincipalId: "p_reviewers",
        memberPrincipalId: "p_member",
        updatedAt: 1,
        sourceVersion: 1,
      });
      await ctx.db.insert("role_permission_overrides", {
        accessScopeId: "scope_default",
        roleId: "role_member",
        permissionId: "perm_posts_read",
        effect: "allow",
        updatedAt: 2,
        sourceVersion: 1,
      });
      await ctx.db.insert("permission_bindings", {
        bindingId: "grant_group_deny",
        subjectPrincipalId: "p_reviewers",
        permissionId: "perm_posts_read",
        effect: "deny",
        accessScopeId: "scope_default",
        resourceType: "posts",
        resourceId: "post_1",
        appliesTo: "self",
        updatedAt: 2,
        sourceVersion: 1,
      });
      await ctx.db.insert("permission_bindings", {
        bindingId: "grant_ancestor_allow",
        subjectPrincipalId: "p_member",
        permissionId: "perm_posts_read",
        effect: "allow",
        accessScopeId: "scope_default",
        resourceType: "folders",
        resourceId: "folder_1",
        appliesTo: "self_and_descendants",
        updatedAt: 2,
        sourceVersion: 1,
      });
      await ctx.db.insert("permission_bindings", {
        bindingId: "grant_expired_allow",
        subjectPrincipalId: "p_member",
        permissionId: "perm_posts_read",
        effect: "allow",
        accessScopeId: "scope_default",
        resourceType: "posts",
        resourceId: "post_1",
        appliesTo: "self",
        expiresAt: 1,
        updatedAt: 2,
        sourceVersion: 1,
      });
    });

    const target = {
      resourceType: "posts",
      resourceId: "post_1",
      ancestors: [{ resourceType: "folders", resourceId: "folder_1" }],
    };
    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_member`,
      tenantId: "scope_default",
      permission: "posts:read",
      ...target,
    });
    const explanation = await t.query(explainAccess, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      userId: "user_member",
      permission: "posts:read",
      target: {
        type: "resource",
        ...target,
      },
    });

    expect(explanation?.allowed).toBe(decision.allowed);
    expect(explanation?.reasonCode).toBe(decision.reasonCode);
    expect(explanation?.explicitDeny).toBe(decision.explicitDeny);
    expect(explanation?.decisiveReason).toBe("explicit_deny");
    expect(explanation?.sources.directGrants).toContainEqual(
      expect.objectContaining({ grantId: "grant_member", grantType: "role" }),
    );
    expect(explanation?.sources.groupMemberships).toContainEqual(
      expect.objectContaining({ groupId: "p_reviewers", active: true }),
    );
    expect(explanation?.sources.roles).toContainEqual(
      expect.objectContaining({ roleId: "role_member", permissionEffect: "allow" }),
    );
    expect(explanation?.sources.roleOverrides).toContainEqual(
      expect.objectContaining({
        roleId: "role_member",
        permissionId: "perm_posts_read",
        effect: "allow",
      }),
    );
    expect(explanation?.sources.resourceGrants).toContainEqual(
      expect.objectContaining({ grantId: "grant_group_deny", effect: "deny" }),
    );
    expect(explanation?.sources.ancestorGrants).toContainEqual(
      expect.objectContaining({ grantId: "grant_ancestor_allow", effect: "allow" }),
    );
    expect(explanation?.sources.explicitDenies).toContainEqual(
      expect.objectContaining({
        objectType: "resource",
        source: expect.objectContaining({ grantId: "grant_group_deny" }),
      }),
    );
    expect(explanation?.sources.expiredIgnoredGrants).toContainEqual(
      expect.objectContaining({ grantId: "grant_expired_allow" }),
    );
  });

  test("explainAccess allowed matches normal authorization", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_member`,
      tenantId: "scope_default",
      permission: "posts:read",
    });
    const explanation = await t.query(explainAccess, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      userId: "user_member",
      permission: "posts:read",
      target: { type: "tenant" },
    });

    expect(decision.allowed).toBe(true);
    expect(explanation?.allowed).toBe(decision.allowed);
    expect(explanation?.reasonCode).toBe(decision.reasonCode);
    expect(explanation?.decisiveReason).toBe("explicit_allow");
  });

  test("explainAccess exposes tenant denies with public tenant terminology", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());
    await t.run(async (ctx) => {
      await ctx.db.insert("permission_bindings", {
        bindingId: "grant_member_tenant_deny",
        subjectPrincipalId: "p_member",
        permissionId: "perm_posts_read",
        effect: "deny",
        accessScopeId: "scope_default",
        appliesTo: "self",
        updatedAt: 2,
        sourceVersion: 1,
      });
    });

    const decision = await t.query(authorize, {
      tokenIdentifier: `${ISSUER}|user_member`,
      tenantId: "scope_default",
      permission: "posts:read",
    });
    const explanation = await t.query(explainAccess, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      userId: "user_member",
      permission: "posts:read",
      target: { type: "tenant" },
    });

    expect(explanation?.allowed).toBe(decision.allowed);
    expect(explanation?.sources.explicitDenies).toContainEqual(
      expect.objectContaining({
        objectType: "tenant",
        source: expect.objectContaining({ grantId: "grant_member_tenant_deny" }),
      }),
    );
  });

  test("explainAccess requires grants read permission", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, adminReadSnapshot());

    await expect(
      t.query(explainAccess, {
        tokenIdentifier: `${ISSUER}|user_member`,
        tenantId: "scope_default",
        userId: "user_owner",
        permission: "posts:read",
        target: { type: "tenant" },
      }),
    ).resolves.toBeNull();
  });
});

describe("listDirectSubjectsForResource", () => {
  test("lists direct grantees on the resource for an authorized caller", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });

    expect(subjects.subjects).toEqual([
      expect.objectContaining({
        type: "user",
        userId: "user_alice",
        grant: {
          grantId: "grant_alice_report_123_read",
          type: "permission",
          permissionId: "perm_reports_read",
          permissionKey: "reports.read",
          effect: "allow",
          appliesTo: "self",
          expiresAt: null,
        },
      }),
    ]);
  });

  test("reports applicability for direct permission and role bindings", async () => {
    const t = convexTest(schema, modules);
    const catalog = resourceCatalogSnapshot();
    catalog.state.roles.push({
      roleId: "role_reporter",
      accessScopeId: "scope_default",
      key: "reporter",
      kind: "iam",
      name: "Reporter",
      wildcard: "none",
      updatedAt: 1,
    });
    const org = resourceOrgSnapshot();
    org.state.grants[1]!.appliesTo = "self_and_descendants";
    org.state.grants.push({
      grantId: "grant_alice_reporter",
      subjectPrincipalId: "p_alice_acme",
      relationKind: "role",
      roleId: "role_reporter",
      effect: "allow",
      objectType: "resource",
      objectId: "report_123",
      objectResourceType: "reports",
      appliesTo: "self",
      updatedAt: 2,
    });

    await t.mutation(applySync, catalog);
    await t.mutation(applySync, org);

    const firstPage = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
      limit: 1,
    });
    expect(firstPage.subjects).toHaveLength(1);
    expect(firstPage.cursor).toEqual(expect.any(String));
    const secondPage = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
      limit: 1,
      cursor: firstPage.cursor,
    });

    expect(
      [...firstPage.subjects, ...secondPage.subjects].map(({ grant, ...subject }) => ({
        grant,
        roleKey: "role" in subject ? subject.role.roleKey : undefined,
      })),
    ).toEqual([
      {
        roleKey: "reporter",
        grant: {
          grantId: "grant_alice_reporter",
          type: "role",
          roleId: "role_reporter",
          expiresAt: null,
          appliesTo: "self",
        },
      },
      {
        roleKey: undefined,
        grant: {
          grantId: "grant_alice_report_123_read",
          type: "permission",
          permissionId: "perm_reports_read",
          permissionKey: "reports.read",
          effect: "allow",
          expiresAt: null,
          appliesTo: "self_and_descendants",
        },
      },
    ]);
  });

  test("returns an empty page when the resource has no direct grants", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    await t.mutation(applySync, resourceOrgSnapshot());

    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_456",
    });
    expect(subjects).toEqual({ subjects: [] });
  });

  test("requires grants read even when the caller can read the resource", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applySync, resourceCatalogSnapshot());
    const org = resourceOrgSnapshot();
    org.state.grants = org.state.grants.filter(
      (grant) => grant.grantId !== "grant_alice_grants_read",
    );
    await t.mutation(applySync, org);

    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_alice`,
      tenantId: "scope_acme",
      resourceType: "reports",
      resourceId: "report_123",
    });

    expect(subjects).toEqual({ subjects: [] });
  });
});

// ── group principal names ────────────────────────────────────────────────────
// The v4 wire carries an optional `name` on a GROUP principal (a user
// principal's name still comes from the deployment-wide user row). Prove the
// name is (a) stored on the mirror principal row by ingestion and (b) surfaced
// by the member and direct-subject listings. This fixture is authored directly
// in the v4 wire shape and therefore passes through the fixture compiler.
describe("group principal names", () => {
  function groupNameSnapshot() {
    return {
      type: "access.projection.snapshot" as const,
      schemaVersion: 4 as const,
      eventId: "evt_group_name",
      mode: "initialize" as const,
      sourceVersion: 1,
      expectedIssuer: ISSUER,
      catalog: {
        roles: [
          {
            roleId: "role_owner",
            key: "owner",
            source: "system" as const,
            name: "Owner",
            description: null,
            baseWildcard: "immutable" as const,
            updatedAt: 1,
          },
          {
            roleId: "role_member",
            key: "member",
            source: "system" as const,
            name: "Member",
            description: null,
            baseWildcard: "none" as const,
            updatedAt: 1,
          },
        ],
        permissions: [
          {
            permissionId: "perm_members_read",
            key: "system.access.users:read",
            resourceType: "system.access.users",
            action: "read",
            classification: "delegable" as const,
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_grants_read",
            key: "system.access.grants:read",
            resourceType: "system.access.grants",
            action: "read",
            classification: "delegable" as const,
            tenantAssignable: false,
            updatedAt: 1,
          },
          {
            permissionId: "perm_reports_read",
            key: "reports:read",
            resourceType: "reports",
            action: "read",
            classification: "delegable" as const,
            tenantAssignable: true,
            updatedAt: 1,
          },
        ],
        rolePermissions: [],
      },
      users: [
        {
          herculesAuthUserId: "user_owner",
          name: "Olivia Owner",
          email: "olivia@example.com",
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
            kind: "default" as const,
            status: "active" as const,
            accessMode: "open" as const,
            defaultRoleId: "role_member",
            updatedAt: 1,
          },
          principals: [
            {
              principalId: "p_owner",
              type: "user" as const,
              herculesAuthUserId: "user_owner",
              status: "active" as const,
              joinedAt: 1001,
              updatedAt: 1,
            },
            {
              principalId: "p_engineering",
              type: "group" as const,
              name: "Engineering",
              status: "active" as const,
              joinedAt: 1000,
              updatedAt: 1,
            },
          ],
          principalMemberships: [
            {
              groupPrincipalId: "p_engineering",
              memberPrincipalId: "p_owner",
              updatedAt: 1002,
            },
          ],
          roles: [],
          rolePermissionOverrides: [],
          roleBindings: [
            {
              bindingId: "rb_owner",
              subjectPrincipalId: "p_owner",
              roleId: "role_owner",
              accessScopeId: "scope_default",
              appliesTo: "self" as const,
              updatedAt: 1,
            },
            {
              bindingId: "rb_engineering",
              subjectPrincipalId: "p_engineering",
              roleId: "role_member",
              accessScopeId: "scope_default",
              appliesTo: "self" as const,
              updatedAt: 1,
            },
            {
              bindingId: "rb_engineering_report",
              subjectPrincipalId: "p_engineering",
              roleId: "role_member",
              accessScopeId: "scope_default",
              resourceType: "reports",
              resourceId: "report_1",
              appliesTo: "self" as const,
              updatedAt: 1,
            },
          ],
          permissionBindings: [],
        },
      ],
    };
  }

  test("an ingested group principal's name is stored and surfaced", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(applySync, groupNameSnapshot() as never)).toMatchObject({
      ok: true,
      status: "applied",
    });

    // Stored: the mirror principal row carries the group's display name.
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("principals")
        .withIndex("by_principal_id", (q) => q.eq("principalId", "p_engineering"))
        .unique(),
    );
    expect(stored).toMatchObject({ type: "group", name: "Engineering", memberCount: 1 });

    // Surfaced through the separate tenant group and user reads.
    const groups = await t.query(listTenantGroups, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });
    const group = groups.groups.find((candidate) => candidate.groupId === "p_engineering");
    expect(group).toMatchObject({
      groupId: "p_engineering",
      name: "Engineering",
      memberCount: 1,
    });
    expect(group?.roles.map((r) => r.roleKey)).toEqual(["member"]);
    expect(group?.directRoleGrants).toEqual([
      {
        grantId: "rb_engineering",
        type: "role",
        roleId: "role_member",
        roleKey: "member",
        roleName: "Member",
        roleKind: "system",
        expiresAt: null,
      },
    ]);
    const users = await t.query(listTenantUsers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
    });
    expect(users.users.find((user) => user.userId === "user_owner")).toMatchObject({
      userId: "user_owner",
      name: "Olivia Owner",
    });

    // Surfaced in the direct-subject listing: the group's direct role binding
    // on the resource is reported under the group's name.
    const subjects = await t.query(listDirectSubjectsForResource, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      resourceType: "reports",
      resourceId: "report_1",
    });
    expect(subjects.subjects).toEqual([
      expect.objectContaining({
        type: "group",
        groupId: "p_engineering",
        name: "Engineering",
      }),
    ]);
  });

  test("membership events keep the stored group member count exact", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(applySync, groupNameSnapshot() as never)).toMatchObject({
      ok: true,
      status: "applied",
    });

    await expect(
      t.mutation(applySync, {
        type: "access.projection.event",
        schemaVersion: 4,
        eventId: "evt_group_member_add",
        sourceVersion: 2,
        scopes: [
          {
            accessScopeId: "scope_default",
            changes: [
              {
                entityType: "principal",
                principalId: "p_second",
                operation: "upsert",
              },
              {
                entityType: "principal_membership",
                groupPrincipalId: "p_engineering",
                memberPrincipalId: "p_second",
                operation: "upsert",
              },
            ],
            principals: [
              {
                principalId: "p_second",
                type: "user",
                herculesAuthUserId: "user_second",
                status: "active",
                joinedAt: 1003,
                updatedAt: 1003,
              },
            ],
            principalMemberships: [
              {
                groupPrincipalId: "p_engineering",
                memberPrincipalId: "p_second",
                updatedAt: 1003,
              },
            ],
            roles: [],
            rolePermissionOverrides: [],
            roleBindings: [],
            permissionBindings: [],
          },
        ],
      } as never),
    ).resolves.toMatchObject({ ok: true, status: "applied" });

    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) => q.eq("principalId", "p_engineering"))
          .unique(),
      ),
    ).resolves.toMatchObject({ memberCount: 2 });

    await expect(
      t.mutation(applySync, {
        type: "access.projection.event",
        schemaVersion: 4,
        eventId: "evt_group_member_delete",
        sourceVersion: 3,
        scopes: [
          {
            accessScopeId: "scope_default",
            changes: [
              {
                entityType: "principal_membership",
                groupPrincipalId: "p_engineering",
                memberPrincipalId: "p_second",
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
      } as never),
    ).resolves.toMatchObject({ ok: true, status: "applied" });

    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) => q.eq("principalId", "p_engineering"))
          .unique(),
      ),
    ).resolves.toMatchObject({ memberCount: 1 });
  });

  test("counts memberships that precede a newly inserted group", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(applySync, groupNameSnapshot() as never)).toMatchObject({
      ok: true,
      status: "applied",
    });

    await expect(
      t.mutation(applySync, {
        type: "access.projection.event",
        schemaVersion: 4,
        eventId: "evt_group_with_member",
        sourceVersion: 2,
        scopes: [
          {
            accessScopeId: "scope_default",
            changes: [
              {
                entityType: "principal_membership",
                groupPrincipalId: "p_design",
                memberPrincipalId: "p_owner",
                operation: "upsert",
              },
              {
                entityType: "principal",
                principalId: "p_design",
                operation: "upsert",
              },
            ],
            principals: [
              {
                principalId: "p_design",
                type: "group",
                name: "Design",
                status: "active",
                joinedAt: 1003,
                updatedAt: 1003,
              },
            ],
            principalMemberships: [
              {
                groupPrincipalId: "p_design",
                memberPrincipalId: "p_owner",
                updatedAt: 1003,
              },
            ],
            roles: [],
            rolePermissionOverrides: [],
            roleBindings: [],
            permissionBindings: [],
          },
        ],
      } as never),
    ).resolves.toMatchObject({ ok: true, status: "applied" });

    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("principals")
          .withIndex("by_principal_id", (q) => q.eq("principalId", "p_design"))
          .unique(),
      ),
    ).resolves.toMatchObject({ type: "group", memberCount: 1 });
  });

  test("paginates groups and reads both sides of group membership", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(applySync, groupNameSnapshot() as never)).toMatchObject({
      ok: true,
      status: "applied",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("principals", {
        accessScopeId: "scope_default",
        principalId: "p_design",
        type: "group",
        name: "Design",
        status: "active",
        joinedAt: 1003,
        updatedAt: 1003,
        memberCount: 1,
        sourceVersion: 1,
      } as never);
      await ctx.db.insert("principal_memberships", {
        accessScopeId: "scope_default",
        groupPrincipalId: "p_design",
        memberPrincipalId: "p_owner",
        updatedAt: 1004,
        sourceVersion: 1,
      });
      await ctx.db.insert("users", {
        herculesAuthUserId: "user_designer",
        name: "Dina Designer",
        email: "dina@example.com",
        emailVerified: true,
        phoneVerified: false,
        updatedAt: 1004,
        sourceVersion: 1,
      });
      await ctx.db.insert("principals", {
        accessScopeId: "scope_default",
        principalId: "p_designer",
        type: "user",
        herculesAuthUserId: "user_designer",
        memberCount: 0,
        status: "active",
        joinedAt: 1004,
        updatedAt: 1004,
        sourceVersion: 1,
      });
      await ctx.db.insert("principal_memberships", {
        accessScopeId: "scope_default",
        groupPrincipalId: "p_engineering",
        memberPrincipalId: "p_designer",
        updatedAt: 1005,
        sourceVersion: 1,
      });
    });

    const firstPage = await t.query(listTenantGroups, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      limit: 1,
    });
    expect(firstPage.groups).toHaveLength(1);
    expect(firstPage.cursor).toEqual(expect.any(String));
    const secondPage = await t.query(listTenantGroups, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(
      new Set([...firstPage.groups, ...secondPage.groups].map((group) => group.groupId)),
    ).toEqual(new Set(["p_engineering", "p_design"]));

    const firstMembersPage = await t.query(listGroupMembers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      groupId: "p_engineering",
      limit: 1,
    });
    expect(firstMembersPage.users).toHaveLength(1);
    expect(firstMembersPage.cursor).toEqual(expect.any(String));
    const secondMembersPage = await t.query(listGroupMembers, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      groupId: "p_engineering",
      limit: 1,
      cursor: firstMembersPage.cursor,
    });
    expect(
      new Set(
        [...firstMembersPage.users, ...secondMembersPage.users].map((member) => member.userId),
      ),
    ).toEqual(new Set(["user_owner", "user_designer"]));

    const firstGroupsPage = await t.query(listUserGroups, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      userId: "user_owner",
      limit: 1,
    });
    expect(firstGroupsPage.groups).toHaveLength(1);
    expect(firstGroupsPage.cursor).toEqual(expect.any(String));
    const secondGroupsPage = await t.query(listUserGroups, {
      tokenIdentifier: `${ISSUER}|user_owner`,
      tenantId: "scope_default",
      userId: "user_owner",
      limit: 1,
      cursor: firstGroupsPage.cursor,
    });
    expect(
      new Set(
        [...firstGroupsPage.groups, ...secondGroupsPage.groups].map((group) => group.groupId),
      ),
    ).toEqual(new Set(["p_engineering", "p_design"]));
  });

  test("reads mirrored resource permission overrides for one subject and target", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(applySync, groupNameSnapshot() as never)).toMatchObject({
      ok: true,
      status: "applied",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("permission_bindings", {
        bindingId: "pb_engineering_report_read",
        subjectPrincipalId: "p_engineering",
        permissionId: "perm_reports_read",
        effect: "deny",
        accessScopeId: "scope_default",
        resourceType: "reports",
        resourceId: "report_1",
        appliesTo: "self",
        updatedAt: 2,
        sourceVersion: 1,
      });
    });

    await expect(
      t.query(getResourcePermissionOverrides, {
        tokenIdentifier: `${ISSUER}|user_owner`,
        tenantId: "scope_default",
        subject: { type: "group", groupId: "p_engineering" },
        resourceType: "reports",
        target: { type: "resource", resourceId: "report_1" },
      }),
    ).resolves.toEqual({
      tenantId: "scope_default",
      subject: { type: "group", groupId: "p_engineering" },
      resourceType: "reports",
      target: { type: "resource", resourceId: "report_1" },
      grants: [
        {
          grantId: "pb_engineering_report_read",
          type: "permission",
          permissionId: "perm_reports_read",
          permissionKey: "reports:read",
          effect: "deny",
          appliesTo: "self",
          expiresAt: null,
        },
      ],
    });
  });
});
