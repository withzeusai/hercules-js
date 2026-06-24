import { describe, expect, test, vi } from "vitest";
import * as iam from "./index";
import {
  createIam,
  DEFAULT_TENANT_SENTINEL,
  defaultTenant,
  tenantFromArg,
  tenantFromResource,
} from "./index";

const identityBuilder = ((definition: unknown) => definition) as never;

const component = {
  checks: {
    authorize: "authorize",
    authorizeMany: "authorizeMany",
  },
  queries: {
    getDeploymentEntryStatus: "getDeploymentEntryStatus",
    listMyTenants: "listMyTenants",
    listMyRoles: "listMyRoles",
    getEffectivePermissions: "getEffectivePermissions",
    getTenant: "getTenant",
    listTenantUsers: "listTenantUsers",
    listTenantGroups: "listTenantGroups",
    listTenantUserDirectory: "listTenantUserDirectory",
    getTenantUserDirectoryEntry: "getTenantUserDirectoryEntry",
    listGroupMembers: "listGroupMembers",
    listUserGroups: "listUserGroups",
    listTenantRoles: "listTenantRoles",
    getTenantRole: "getTenantRole",
    listTenantPermissions: "listTenantPermissions",
    getResourcePermissionOverrides: "getResourcePermissionOverrides",
    explainAccess: "explainAccess",
    listDirectSubjectsForResource: "listDirectSubjectsForResource",
  },
} as never;

describe("tenant IAM client surface", () => {
  test("exposes tenant terminology without scope aliases", () => {
    const exports = iam as Record<string, unknown>;

    expect(exports.DEFAULT_TENANT_SENTINEL).toBe("__hercules_default_tenant__");
    expect(exports.defaultTenant).toBeTypeOf("function");
    expect(exports.tenantFromArg).toBeTypeOf("function");
    expect(exports.tenantFromResource).toBeTypeOf("function");
    expect(exports).not.toHaveProperty("DEFAULT_SCOPE_SENTINEL");
    expect(exports).not.toHaveProperty("defaultScope");
    expect(exports).not.toHaveProperty("scopeFromArg");
    expect(exports).not.toHaveProperty("scopeFromResource");
  });

  test("returns separate tenant user and group readers", () => {
    const builders = createIam({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component,
    });

    expect(builders.listMyTenants).toBeTypeOf("function");
    expect(builders.getTenant).toBeTypeOf("function");
    expect(builders.listTenantUsers).toBeTypeOf("function");
    expect(builders.listTenantGroups).toBeTypeOf("function");
    expect(builders.listTenantUserDirectory).toBeTypeOf("function");
    expect(builders.getTenantUserDirectoryEntry).toBeTypeOf("function");
    expect(builders.listGroupMembers).toBeTypeOf("function");
    expect(builders.listUserGroups).toBeTypeOf("function");
    expect(builders.listTenantRoles).toBeTypeOf("function");
    expect(builders.getTenantRole).toBeTypeOf("function");
    expect(builders.listTenantPermissions).toBeTypeOf("function");
    expect(builders.getResourcePermissionOverrides).toBeTypeOf("function");
    expect(builders.explainAccess).toBeTypeOf("function");
    expect(builders).not.toHaveProperty("listMyMemberships");
    expect(builders).not.toHaveProperty("listScopeMembers");
  });

  test("extracts explicit and row-owned tenant ids", async () => {
    expect(tenantFromArg("tenantId")({}, { tenantId: "tenant_1" })).toBe("tenant_1");
    expect(defaultTenant({}, {})).toBe(DEFAULT_TENANT_SENTINEL);

    const get = vi.fn().mockResolvedValue({ tenantId: "tenant_1" });
    await expect(
      tenantFromResource("projects", "projectId")({ db: { get } }, { projectId: "project_1" }),
    ).resolves.toMatchObject({
      tenantId: "tenant_1",
      resourceId: "project_1",
    });
  });
});
