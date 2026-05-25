import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { ComponentApi } from "../_generated/component";
import {
  createAccessControl,
  scopeFromArg,
  scopeFromResource,
  type AccessControlComponent,
} from "./index";

const component = {
  checks: { authorize: "authorize" },
  queries: {
    listMyMemberships: "listMyMemberships",
    listMyRoles: "listMyRoles",
    getEffectivePermissions: "getEffectivePermissions",
  },
};

describe("createAccessControl", () => {
  test("accepts the generated component API type", () => {
    expectTypeOf<ComponentApi<"accessControl">>().toMatchTypeOf<AccessControlComponent>();
  });

  test("requires access builders to declare a permission", () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });

    expect(() =>
      builders.accessMutation({
        args: {},
        extractScope: scopeFromArg("scopeId"),
        handler: async () => null,
      } as never),
    ).toThrow("access* builders require a non-empty permission.");
  });

  test("requires access builders to declare an extractScope", () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });

    expect(() =>
      builders.accessMutation({
        permission: "tasks:create",
        args: {},
        handler: async () => null,
      } as never),
    ).toThrow("access* builders require an extractScope function.");
  });

  test("authenticated builders fail closed when authorization denies", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.authenticatedQuery({
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|user_1" }),
      },
      runQuery: vi
        .fn()
        .mockResolvedValue({
          allowed: false,
          reasonCode: "unexpected_issuer",
          effectiveRoleIds: [],
        }),
    };

    await expect(handler.handler(ctx)).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: undefined,
      permission: undefined,
    });
  });

  test("access builders pass the extracted scope and permission to the component check", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.accessMutation({
      permission: "appointments:create",
      extractScope: scopeFromArg("orgScopeId"),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|user_1" }),
      },
      runQuery: vi
        .fn()
        .mockResolvedValue({
          allowed: true,
          reasonCode: "allowed",
          sourceVersion: 1,
          principalId: "principal_1",
          effectiveRoleIds: ["role_member"],
        }),
    };

    await expect(handler.handler(ctx, { orgScopeId: "scope_abc" })).resolves.toBe("ok");
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      permission: "appointments:create",
    });
  });

  test("read helpers use the configured access component", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|user_1" }),
      },
      runQuery: vi.fn(async (ref: string) => {
        if (ref === "authorize") {
          return {
            allowed: true,
            reasonCode: "allowed",
            sourceVersion: 1,
            principalId: "principal_1",
            effectiveRoleIds: ["role_member"],
          };
        }
        if (ref === "getEffectivePermissions") {
          return {
            allowed: true,
            reasonCode: "allowed",
            sourceVersion: 1,
            scopeId: "scope_abc",
            principalId: "principal_1",
            effectiveRoleIds: ["role_member"],
            permissions: ["tasks.read"],
          };
        }
        if (ref === "listMyMemberships") {
          return [
            {
              scopeId: "scope_abc",
              scopeName: "Acme",
              kind: "org",
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roles: [
                {
                  roleId: "role_member",
                  roleKey: "member",
                  roleName: "Member",
                  roleKind: "system",
                },
              ],
              joinedAt: 1,
              status: "active",
            },
          ];
        }
        if (ref === "listMyRoles") {
          return [
            {
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roleKind: "system",
            },
          ];
        }
        throw new Error(`Unexpected query ref ${ref}`);
      }),
    };

    await expect(
      builders.hasPermission(ctx as never, {
        scopeId: "scope_abc",
        permission: "tasks.read",
        resource: { type: "tasks", id: "task_1" },
      }),
    ).resolves.toBe(true);
    await expect(
      builders.getEffectivePermissions(ctx as never, {
        scopeId: "scope_abc",
      }),
    ).resolves.toEqual(["tasks.read"]);
    await expect(builders.listMyMemberships(ctx as never)).resolves.toHaveLength(1);
    await expect(builders.listMyRoles(ctx as never, { scopeId: "scope_abc" })).resolves.toEqual([
      {
        roleId: "role_member",
        roleKey: "member",
        roleName: "Member",
        roleKind: "system",
      },
    ]);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      permission: "tasks.read",
      resourceType: "tasks",
      resourceId: "task_1",
    });
  });

  test("access builders surface a ConvexError when extractScope returns no scope", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.accessMutation({
      permission: "appointments:create",
      extractScope: scopeFromArg("orgScopeId"),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: Function };

    const ctx = {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|user_1" }),
      },
      runQuery: vi.fn(),
    };

    await expect(handler.handler(ctx, {})).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("scopeFromResource reads the scope field from the loaded row", async () => {
    const extract = scopeFromResource("loans", "loanId");
    const ctx = { db: { get: vi.fn().mockResolvedValue({ orgScopeId: "scope_xyz" }) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      scopeId: "scope_xyz",
      resourceType: "loans",
      resourceId: "loan_1",
    });
    expect(ctx.db.get).toHaveBeenCalledWith("loan_1");
  });

  test("scopeFromResource accepts a custom scopeField", async () => {
    const extract = scopeFromResource("loans", "loanId", { scopeField: "accessScopeId" });
    const ctx = { db: { get: vi.fn().mockResolvedValue({ accessScopeId: "scope_legacy" }) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      scopeId: "scope_legacy",
      resourceType: "loans",
      resourceId: "loan_1",
    });
  });

  test("scopeFromResource throws when the row is missing the scope field", async () => {
    const extract = scopeFromResource("loans", "loanId");
    const ctx = { db: { get: vi.fn().mockResolvedValue({}) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).rejects.toBeInstanceOf(ConvexError);
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}
