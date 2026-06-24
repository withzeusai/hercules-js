import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as management from "./iam-management";
import * as service from "./iam-service";

const sharedActionNames = [
  "addGroupMember",
  "archiveAdmissionRule",
  "archiveGroup",
  "archiveRole",
  "createAdmissionRule",
  "createGroup",
  "createInvitation",
  "createResourceGrant",
  "createRole",
  "createUser",
  "deleteGrant",
  "evaluateGrantableRoles",
  "listAdmissionRules",
  "listAuditEvents",
  "listGroupPermissionOverrides",
  "listInvitations",
  "listRolePermissionOverrides",
  "listUserPermissionOverrides",
  "removeGroupMember",
  "removeUser",
  "replaceGroupRoles",
  "replaceGroupPermissionOverrides",
  "replaceResourceGrants",
  "replaceResourcePermissionOverrides",
  "replaceRolePermissionOverrides",
  "replaceUserPermissionOverrides",
  "replaceUserRoles",
  "revokeInvitation",
  "updateAdmissionRule",
  "updateGrant",
  "updateGroup",
  "updateRole",
  "updateTenant",
  "updateUser",
] as const;

const identityBuilder = ((definition: unknown) => definition) as never;

describe("IAM action surface", () => {
  test("exports only the tenant-based management helpers", () => {
    expect(Object.keys(management).sort()).toEqual([
      "acceptIamInvitation",
      "createDeploymentEntryAction",
      "createIamManagementActions",
      "createIamTenant",
      "createIamTenantAction",
      "createResourceCreatorBootstrapAction",
    ]);
  });

  test("exports only the tenant-based service factory", () => {
    expect(Object.keys(service).sort()).toEqual(["createIamServiceActions"]);
  });

  test("exposes the exact management and service action collections", () => {
    const client = {
      get: async () => ({}),
      post: async () => ({}),
      patch: async () => ({}),
      put: async () => ({}),
      delete: async () => ({}),
    };
    const managementActions = management.createIamManagementActions({
      authenticatedAction: identityBuilder,
      client,
    });
    const serviceActions = service.createIamServiceActions({
      internalAction: identityBuilder,
      client,
    });

    expect(Object.keys(managementActions).sort()).toEqual(
      [...sharedActionNames, "evaluateTenantEntry"].sort(),
    );
    expect(Object.keys(serviceActions).sort()).toEqual(
      [...sharedActionNames, "archiveTenant"].sort(),
    );
  });

  test("organizes implementation by IAM resource", async () => {
    const files = await readdir(new URL("./iam", import.meta.url));

    expect(files.sort()).toEqual(
      [
        "admission-rules.ts",
        "audit-events.ts",
        "factory.ts",
        "grants.ts",
        "groups.ts",
        "invitations.ts",
        "payloads.ts",
        "resources.ts",
        "responses.ts",
        "roles.ts",
        "shared.ts",
        "tenants.ts",
        "transport.ts",
        "types.ts",
        "users.ts",
        "validators.ts",
      ].sort(),
    );
  });
});
