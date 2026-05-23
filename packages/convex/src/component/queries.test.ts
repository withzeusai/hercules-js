import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import type { AccessProjectionSnapshot } from "../shared/sync";
import schema from "./schema";

const modules = import.meta.glob(["/src/**/*.ts", "!/src/**/*.test.ts"]);

const applySync = makeFunctionReference<"mutation">("component/sync:applySync");
const listMyMemberships = makeFunctionReference<"query">("component/queries:listMyMemberships");

const ISSUER = "https://auth.example.com";

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

function memberSnapshot(
  scopeId: string,
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
): AccessProjectionSnapshot {
  return {
    type: "access.projection.snapshot",
    schemaVersion: 1,
    eventId: options.eventId,
    sourceVersion: options.sourceVersion,
    expectedIssuer: ISSUER,
    scope: {
      accessScopeId: scopeId,
      name: scopeName,
      kind: scopeKind,
      status: scopeStatus,
      accountEntryMode: "open",
      defaultRoleId: options.roleId,
      updatedAt: 1,
    },
    entities: {
      ...emptyEntities(),
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
          key: scopeKind === "default" ? "owner" : "admin",
          kind: "system",
          name: scopeKind === "default" ? "Owner" : "Admin",
          updatedAt: 1,
        },
      ],
      grants: [
        {
          grantId: options.grantId,
          subjectPrincipalId: options.userPrincipalId,
          roleId: options.roleId,
          objectType: "scope",
          objectId: scopeId,
          updatedAt: 1,
        },
      ],
    },
  };
}

describe("listMyMemberships", () => {
  test("returns memberships across multiple active scopes", async () => {
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

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(2);
    const byScope = new Map(memberships.map((m) => [m.scopeId, m]));
    expect(byScope.get("scope_default")?.roleKey).toBe("owner");
    expect(byScope.get("scope_default")?.kind).toBe("default");
    expect(byScope.get("scope_acme")?.roleKey).toBe("admin");
    expect(byScope.get("scope_acme")?.kind).toBe("org");
    expect(byScope.get("scope_default")?.joinedAt).toBe(1001);
    expect(byScope.get("scope_acme")?.joinedAt).toBe(1002);
  });

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

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: `${ISSUER}|user_alice`,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.scopeId).toBe("scope_default");
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

    const memberships = await t.query(listMyMemberships, {
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

    const memberships = await t.query(listMyMemberships, {
      tokenIdentifier: "https://other.example.com|user_alice",
    });
    expect(memberships).toEqual([]);
  });
});
