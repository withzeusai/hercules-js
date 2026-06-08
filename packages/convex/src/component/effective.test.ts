import { describe, expect, test } from "vitest";
import { enumeratePermissions } from "./effective";

const ownerOnlyPermission = {
  permissionId: "permission_owner_only",
  key: "system.access:manage",
  resourceType: "system.access",
  action: "manage",
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
            resourceType: "system.access",
            action: "manage",
            objectType: "scope",
            permissionId: "permission_owner_only",
          },
        ],
        {},
      ),
    ).toEqual([]);
  });

  test("enumerates owner-only permissions for the immutable owner", () => {
    expect(
      enumeratePermissions([ownerOnlyPermission], "immutable", [], {}),
    ).toEqual([ownerOnlyPermission]);
  });

  test("does not narrow the immutable owner with an explicit deny", () => {
    expect(
      enumeratePermissions(
        [ownerOnlyPermission],
        "immutable",
        [
          {
            effect: "deny",
            resourceType: "system.access",
            action: "manage",
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
