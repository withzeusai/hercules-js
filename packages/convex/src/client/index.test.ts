import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { ComponentApi } from "../_generated/component";
import {
  DEFAULT_SCOPE_SENTINEL,
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
    expectTypeOf<ComponentApi<"hercules">>().toMatchTypeOf<AccessControlComponent>();
  });

  test("resolves the Hercules-mounted component by default", () => {
    const herculesComponent = { ...component, checks: { authorize: "herculesAuthorize" } };
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      components: { hercules: herculesComponent },
    });
    const definition = builders.authenticatedQuery({
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
        .mockResolvedValue({ allowed: true, reasonCode: "allowed", effectiveRoleIds: [] }),
    };

    return definition.handler(ctx).then(() => {
      expect(ctx.runQuery).toHaveBeenCalledWith("herculesAuthorize", expect.any(Object));
    });
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
        scope: scopeFromArg("scopeId"),
        handler: async () => null,
      } as never),
    ).toThrow("access* builders require a non-empty permission.");
  });

  test("defaults access builders to the app scope", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.accessMutation({
      permission: "tasks:create",
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

    await expect(handler.handler(ctx, {})).resolves.toBe("ok");
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: DEFAULT_SCOPE_SENTINEL,
      permission: "tasks:create",
    });
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
      scope: scopeFromArg("orgScopeId"),
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
            { roleId: "role_member", roleKey: "member", roleName: "Member", roleKind: "system" },
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
      builders.getEffectivePermissions(ctx as never, { scopeId: "scope_abc" }),
    ).resolves.toEqual(["tasks.read"]);
    await expect(builders.listMyMemberships(ctx as never)).resolves.toHaveLength(1);
    await expect(builders.listMyRoles(ctx as never, { scopeId: "scope_abc" })).resolves.toEqual([
      { roleId: "role_member", roleKey: "member", roleName: "Member", roleKind: "system" },
    ]);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      permission: "tasks.read",
      resourceType: "tasks",
      resourceId: "task_1",
    });
  });

  test("hasPermission accepts a permission key and defaults to the app scope", async () => {
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

    await expect(builders.hasPermission(ctx, "tasks.create")).resolves.toBe(true);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: DEFAULT_SCOPE_SENTINEL,
      permission: "tasks.create",
    });
  });

  test("filterAuthorizedResources keeps only the rows the caller can access", async () => {
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
      runQuery: vi.fn(async (_ref: string, args: { resourceId: string }) => ({
        allowed: args.resourceId === "p1",
        reasonCode: "allowed",
        effectiveRoleIds: [],
      })),
    };

    const rows = [
      { _id: "p1", title: "A" },
      { _id: "p2", title: "B" },
    ];
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: rows,
      permission: "app.project:view",
      scopeId: "scope_1",
      resource: (row) => ({ type: "app.project", id: row._id }),
    });

    expect(result).toEqual([{ _id: "p1", title: "A" }]);
    expect(ctx.runQuery).toHaveBeenCalledTimes(2);
    expect(ctx.runQuery).toHaveBeenNthCalledWith(1, "authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_1",
      permission: "app.project:view",
      resourceType: "app.project",
      resourceId: "p1",
    });
  });

  test("filterAuthorizedResources returns [] when the caller is unauthenticated", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = { auth: { getUserIdentity: vi.fn().mockResolvedValue(null) }, runQuery: vi.fn() };
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: [{ _id: "p1" }],
      permission: "app.project:view",
      resource: (row) => ({ type: "app.project", id: row._id }),
    });
    expect(result).toEqual([]);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("access builders surface a ConvexError when scope extraction returns no scope", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.accessMutation({
      permission: "appointments:create",
      scope: scopeFromArg("orgScopeId"),
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
    const ctx = { db: { get: vi.fn().mockResolvedValue({ accessScopeId: "scope_custom" }) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      scopeId: "scope_custom",
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

describe("scopeFromResource hierarchy (authorizeAgainst)", () => {
  function makeTaskMutation(
    authorizeAgainst?: (row: Record<string, unknown>) => Array<{
      resourceType: string;
      resourceId: string;
    }>,
  ) {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    return builders.accessMutation({
      permission: "app.task:edit",
      scope: scopeFromResource("tasks", "taskId", { authorizeAgainst }),
      args: {},
      handler: async () => "ok",
    } as never) as unknown as { handler: (ctx: unknown, args: unknown) => Promise<unknown> };
  }

  function makeCtx(
    runQuery: ReturnType<typeof vi.fn>,
    row: Record<string, unknown> = { orgScopeId: "scope_1", projectId: "proj_1" },
  ) {
    return {
      auth: {
        getUserIdentity: vi
          .fn()
          .mockResolvedValue({ tokenIdentifier: "https://auth.example.com|user_1" }),
      },
      runQuery,
      db: { get: vi.fn().mockResolvedValue(row) },
    };
  }

  test("allows via an ancestor when the resource itself denies (union)", async () => {
    const handler = makeTaskMutation((task) => [
      { resourceType: "app.project", resourceId: String(task.projectId) },
    ]);
    const runQuery = vi.fn(async (_ref: string, a: { resourceType?: string }) => ({
      allowed: a.resourceType === "app.project",
      reasonCode: a.resourceType === "app.project" ? "allowed" : "denied",
      effectiveRoleIds: [],
    }));
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery).toHaveBeenNthCalledWith(
      1,
      "authorize",
      expect.objectContaining({ resourceType: "tasks", resourceId: "task_1" }),
    );
    expect(runQuery).toHaveBeenNthCalledWith(
      2,
      "authorize",
      expect.objectContaining({
        resourceType: "app.project",
        resourceId: "proj_1",
        permission: "app.task:edit",
      }),
    );
  });

  test("does not check ancestors when the resource itself allows", async () => {
    const handler = makeTaskMutation((task) => [
      { resourceType: "app.project", resourceId: String(task.projectId) },
    ]);
    const runQuery = vi
      .fn()
      .mockResolvedValue({ allowed: true, reasonCode: "allowed", effectiveRoleIds: [] });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("denies when neither the resource nor any ancestor allows", async () => {
    const handler = makeTaskMutation((task) => [
      { resourceType: "app.project", resourceId: String(task.projectId) },
    ]);
    const runQuery = vi
      .fn()
      .mockResolvedValue({ allowed: false, reasonCode: "denied", effectiveRoleIds: [] });
    await expect(
      handler.handler(makeCtx(runQuery), { taskId: "task_1" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  test("default path without authorizeAgainst makes exactly one authorize call", async () => {
    const handler = makeTaskMutation();
    const runQuery = vi
      .fn()
      .mockResolvedValue({ allowed: true, reasonCode: "allowed", effectiveRoleIds: [] });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("rejects an over-long ancestor chain before any authorize call", async () => {
    const handler = makeTaskMutation(() =>
      Array.from({ length: 11 }, (_unused, i) => ({
        resourceType: "app.project",
        resourceId: `p${i}`,
      })),
    );
    const runQuery = vi
      .fn()
      .mockResolvedValue({ allowed: false, reasonCode: "denied", effectiveRoleIds: [] });
    await expect(
      handler.handler(makeCtx(runQuery), { taskId: "task_1" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(runQuery).not.toHaveBeenCalled();
  });
});
