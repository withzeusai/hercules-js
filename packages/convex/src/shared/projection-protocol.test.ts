import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  accessProjectionEventSchema,
  accessProjectionSnapshotSchema,
  accessProjectionSyncPayloadSchema,
} from "./projection-protocol";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/projection-v3/", import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8"));
}

describe("Access Control projection v3 consumer schemas", () => {
  test("snapshot.json parses under the snapshot schema", () => {
    const snapshot = loadFixture("snapshot.json");

    const parsed = accessProjectionSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(accessProjectionSyncPayloadSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("event-catalog.json parses under the event schema", () => {
    const event = loadFixture("event-catalog.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  test("event-user.json parses under the event schema", () => {
    const event = loadFixture("event-user.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  test("event-scope.json parses under the event schema", () => {
    const event = loadFixture("event-scope.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  // "removed" is the MANUAL admin-eviction status (split out of "blocked").
  // The consumer wire must accept it so ingestion can mirror an evicted member.
  test("a principal with status removed parses", () => {
    const snapshot = loadFixture("snapshot.json") as {
      scopes: { principals: { status: string }[] }[];
    };
    const updated = structuredClone(snapshot);
    updated.scopes[0]!.principals[0]!.status = "removed";

    const result = accessProjectionSnapshotSchema.safeParse(updated);
    expect(result.success).toBe(true);
  });

  test("an upsert change with a missing row fails the integrity superRefine", () => {
    const event = loadFixture("event-scope.json") as { scopes: { principals: unknown[] }[] };
    // Drop the row the principal upsert change points at; the change now matches
    // zero rows, so the C3 integrity rule must reject the event.
    const corrupted = structuredClone(event);
    corrupted.scopes[0]!.principals = [];

    const result = accessProjectionEventSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("expected exactly 1 row, found 0"),
      ),
    ).toBe(true);
  });

  // E1 (impersonation fence): a group principal carrying a herculesAuthUserId
  // would be resolvable as that user. The schema must reject it at parse.
  test("a group principal carrying a herculesAuthUserId is rejected", () => {
    const snapshot = loadFixture("snapshot.json") as {
      scopes: { principals: { type: string; herculesAuthUserId?: string }[] }[];
    };
    const corrupted = structuredClone(snapshot);
    // Promote the default scope's first principal to a group BUT keep the
    // victim's herculesAuthUserId (u_alice). This is the impersonation payload.
    corrupted.scopes[0]!.principals[0]!.type = "group";

    const result = accessProjectionSnapshotSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("group principal must not carry a herculesAuthUserId"),
      ),
    ).toBe(true);
  });

  test("a user principal missing its herculesAuthUserId is rejected", () => {
    const snapshot = loadFixture("snapshot.json") as {
      scopes: { principals: { type: string; herculesAuthUserId?: string }[] }[];
    };
    const corrupted = structuredClone(snapshot);
    delete corrupted.scopes[0]!.principals[0]!.herculesAuthUserId;

    const result = accessProjectionSnapshotSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("user principal requires a herculesAuthUserId"),
      ),
    ).toBe(true);
  });

  // E2 (tenant role wildcard fence): a tenant role's baseWildcard must always be
  // "none"; a wire payload claiming "default"/"immutable" must fail at parse so a
  // tenant role can never become Admin/Owner-equivalent.
  test("a tenant role with a non-none baseWildcard is rejected at parse", () => {
    const snapshot = loadFixture("snapshot.json") as {
      scopes: { roles: { baseWildcard: string }[] }[];
    };
    const corrupted = structuredClone(snapshot);
    // The org scope (index 1) owns a tenant role (role_org_lead). Flip its
    // intrinsic wildcard to the Admin-equivalent "default".
    corrupted.scopes[1]!.roles[0]!.baseWildcard = "default";

    const result = accessProjectionSnapshotSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  // E4 (cross-scope escalation fence): a scope-A block that nests a binding
  // targeting scope B must be rejected at parse.
  test("a snapshot scope embedding a foreign-scope role binding is rejected", () => {
    const snapshot = loadFixture("snapshot.json") as {
      scopes: { scope: { accessScopeId: string }; roleBindings: { accessScopeId: string }[] }[];
    };
    const corrupted = structuredClone(snapshot);
    // The default scope (index 0) ships a role binding; re-point it at the org
    // scope (as_org1). Scope-A delta granting in scope B.
    corrupted.scopes[0]!.roleBindings[0]!.accessScopeId = "as_org1";

    const result = accessProjectionSnapshotSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("accessScopeId must equal the enclosing scope"),
      ),
    ).toBe(true);
  });

  test("an event scope delta embedding a foreign-scope override is rejected", () => {
    // Build a scope delta for as_default that nests a role_permission_override
    // targeting as_org1 (with a matching change identity referencing as_org1).
    const event = {
      type: "access.projection.event" as const,
      schemaVersion: 3 as const,
      eventId: "evt_cross_scope_0001",
      sourceVersion: 11,
      scopes: [
        {
          accessScopeId: "as_default",
          changes: [
            {
              entityType: "role_permission_override" as const,
              accessScopeId: "as_org1",
              roleId: "role_admin",
              permissionId: "perm_docs_write",
              operation: "upsert" as const,
            },
          ],
          principals: [],
          principalMemberships: [],
          roles: [],
          rolePermissionOverrides: [
            {
              accessScopeId: "as_org1",
              roleId: "role_admin",
              permissionId: "perm_docs_write",
              effect: "allow" as const,
              updatedAt: 1780444800000,
            },
          ],
          roleBindings: [],
          permissionBindings: [],
        },
      ],
    };

    const result = accessProjectionEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("accessScopeId must equal the enclosing scope"),
      ),
    ).toBe(true);
  });
});
