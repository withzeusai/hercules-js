import { describe, expect, test } from "vitest";
import { enumeratePermissions } from "./effective";

// Owner-only catalog permission with a CONCRETE action: superset-action keys
// (`manage`/`*`) are filtered from the enumeration outright (see the
// superset-action describe below), so the classification fence is exercised on
// a runtime-checkable key.
const ownerOnlyPermission = {
  permissionId: "permission_owner_only",
  key: "system.ownership:transfer",
  resourceType: "system.ownership",
  action: "transfer",
  classification: "owner_only" as const,
};

describe("enumeratePermissions classification", () => {
  test("does not enumerate an explicitly allowed owner-only permission", () => {
    expect(
      enumeratePermissions(
        [ownerOnlyPermission],
        "none",
        [
          {
            effect: "allow",
            resourceType: "system.ownership",
            action: "transfer",
            objectType: "scope",
            permissionId: "permission_owner_only",
          },
        ],
        {},
      ),
    ).toEqual([]);
  });

  test("enumerates owner-only permissions for the immutable owner", () => {
    expect(enumeratePermissions([ownerOnlyPermission], "immutable", [], {})).toEqual([
      ownerOnlyPermission,
    ]);
  });

  test("does not narrow the immutable owner with an explicit deny", () => {
    expect(
      enumeratePermissions(
        [ownerOnlyPermission],
        "immutable",
        [
          {
            effect: "deny",
            resourceType: "system.ownership",
            action: "transfer",
            objectType: "scope",
            permissionId: "permission_owner_only",
          },
        ],
        {},
      ),
    ).toEqual([ownerOnlyPermission]);
  });

  test("expands a manage deny across matching CRUD permissions", () => {
    const readPermission = {
      permissionId: "permission_reports_read",
      key: "reports:read",
      resourceType: "reports",
      action: "read",
      classification: "delegable" as const,
    };

    expect(
      enumeratePermissions(
        [readPermission],
        "none",
        [
          {
            effect: "allow",
            resourceType: "reports",
            action: "read",
            objectType: "scope",
            permissionId: "permission_reports_read",
          },
          {
            effect: "deny",
            resourceType: "reports",
            action: "manage",
            objectType: "scope",
            permissionId: "permission_reports_manage",
          },
        ],
        {},
      ),
    ).toEqual([]);
  });
});

// L-3 (runtime enumeration mismatch): superset-action catalog keys
// (`:manage`, `:*`) are control-plane management gates; the authorize gate
// (checks.ts) rejects a request that resolves to one with `invalid_request`
// for EVERY principal, Owner included. The enumeration must therefore never
// advertise them — only the concrete-verb keys a `manage`/`*` grant expands
// onto are runtime capabilities.
describe("enumeratePermissions superset-action keys (control-plane-only)", () => {
  const managePermission = {
    permissionId: "permission_reports_manage",
    key: "reports:manage",
    resourceType: "reports",
    action: "manage",
    classification: "delegable" as const,
  };
  const wildcardPermission = {
    permissionId: "permission_reports_all",
    key: "reports:*",
    resourceType: "reports",
    action: "*",
    classification: "delegable" as const,
  };
  const readPermission = {
    permissionId: "permission_reports_read",
    key: "reports:read",
    resourceType: "reports",
    action: "read",
    classification: "delegable" as const,
  };
  const catalog = [managePermission, wildcardPermission, readPermission];

  test("a manage grant expands to concrete verbs without advertising the manage key", () => {
    expect(
      enumeratePermissions(
        catalog,
        "none",
        [
          {
            effect: "allow",
            resourceType: "reports",
            action: "manage",
            objectType: "scope",
            permissionId: "permission_reports_manage",
          },
        ],
        {},
      ),
    ).toEqual([readPermission]);
  });

  test("the immutable owner does not enumerate manage/* catalog keys", () => {
    expect(enumeratePermissions(catalog, "immutable", [], {})).toEqual([readPermission]);
  });

  test("the default-wildcard admin does not enumerate manage/* catalog keys", () => {
    expect(enumeratePermissions(catalog, "default", [], {})).toEqual([readPermission]);
  });
});
