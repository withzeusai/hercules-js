import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { ComponentApi } from "../_generated/component";
import {
  DEFAULT_SCOPE_SENTINEL,
  PERMISSION_RESOURCE_TYPE_SENTINEL,
  createAccessControl,
  scopeFromArg,
  scopeFromDefaultParentResource,
  scopeFromDefaultResource,
  scopeFromParentResource,
  scopeFromResource,
  type AccessControlComponent,
} from "./index";

// A stand-in for Convex's query/mutation/action builders: returns the function
// definition unchanged so the tests can pull `.handler` back out. Typed as
// `never` so it satisfies the precise QueryBuilder/MutationBuilder/ActionBuilder
// parameter types the factory expects without reconstructing those builder types.
const identityBuilder = ((definition: unknown) => definition) as never;

const component = {
  checks: { authorize: "authorize", authorizeMany: "authorizeMany" },
  queries: {
    getDeploymentEntryStatus: "getDeploymentEntryStatus",
    listMyMemberships: "listMyMemberships",
    listMyRoles: "listMyRoles",
    getEffectivePermissions: "getEffectivePermissions",
    listScopeMemberDirectory: "listScopeMemberDirectory",
    getScopeMemberDirectoryEntry: "getScopeMemberDirectoryEntry",
  },
};

describe("createAccessControl", () => {
  test("accepts the generated component API type", () => {
    expectTypeOf<ComponentApi<"hercules">>().toMatchTypeOf<AccessControlComponent>();
  });

  test("resolves the Hercules-mounted component by default", () => {
    const herculesComponent = {
      ...component,
      checks: { authorize: "herculesAuthorize" },
    };
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        effectiveRoleIds: [],
      }),
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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
        if (ref === "getDeploymentEntryStatus") {
          return {
            kind: "principal",
            principalId: "principal_1",
            status: "active",
            stateVersion: 1,
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
            {
              roleId: "role_member",
              roleKey: "member",
              roleName: "Member",
              roleKind: "system",
            },
          ];
        }
        if (ref === "listScopeMemberDirectory") {
          return {
            members: [
              {
                principalId: "principal_1",
                herculesAuthUserId: "user_1",
                name: "Alice",
                email: "alice@example.com",
              },
            ],
            cursor: "cursor_2",
          };
        }
        if (ref === "getScopeMemberDirectoryEntry") {
          return {
            principalId: "principal_1",
            herculesAuthUserId: "user_1",
            name: "Alice",
            email: "alice@example.com",
          };
        }
        if (ref === "authorizeMany") {
          return [
            {
              allowed: true,
              reasonCode: "allowed",
              sourceVersion: 1,
              principalId: "principal_1",
              effectiveRoleIds: ["role_member"],
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
        resource: { type: "app.projects" },
      }),
    ).resolves.toEqual(["tasks.read"]);
    await expect(builders.getDeploymentEntryStatus(ctx as never)).resolves.toEqual({
      kind: "principal",
      principalId: "principal_1",
      status: "active",
      stateVersion: 1,
    });
    await expect(builders.listMyMemberships(ctx as never)).resolves.toHaveLength(1);
    await expect(builders.listMyRoles(ctx as never, { scopeId: "scope_abc" })).resolves.toEqual([
      {
        roleId: "role_member",
        roleKey: "member",
        roleName: "Member",
        roleKind: "system",
      },
    ]);
    await expect(
      builders.listScopeMemberDirectory(ctx as never, {
        scopeId: "scope_abc",
        cursor: "cursor_1",
        limit: 25,
      }),
    ).resolves.toEqual({
      members: [
        {
          principalId: "principal_1",
          herculesAuthUserId: "user_1",
          name: "Alice",
          email: "alice@example.com",
        },
      ],
      nextCursor: "cursor_2",
    });
    await expect(
      builders.getScopeMemberDirectoryEntry(ctx as never, {
        scopeId: "scope_abc",
        herculesAuthUserId: "user_1",
      }),
    ).resolves.toEqual({
      principalId: "principal_1",
      herculesAuthUserId: "user_1",
      name: "Alice",
      email: "alice@example.com",
    });
    await expect(
      builders.checkPermissions(ctx as never, [
        {
          scopeId: "scope_abc",
          permission: "tasks.read",
          resource: { type: "tasks", id: "task_1" },
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        allowed: true,
        reasonCode: "allowed",
      }),
    ]);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      permission: "tasks.read",
      resourceType: "tasks",
      resourceId: "task_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getEffectivePermissions", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      resourceType: "app.projects",
      resourceId: undefined,
      ancestors: undefined,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getDeploymentEntryStatus", {
      tokenIdentifier: "https://auth.example.com|user_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("listScopeMemberDirectory", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      cursor: "cursor_1",
      limit: 25,
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("getScopeMemberDirectoryEntry", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_abc",
      herculesAuthUserId: "user_1",
    });
    expect(ctx.runQuery).toHaveBeenCalledWith("authorizeMany", {
      tokenIdentifier: "https://auth.example.com|user_1",
      checks: [
        {
          scopeId: "scope_abc",
          permission: "tasks.read",
          resourceType: "tasks",
          resourceId: "task_1",
          ancestors: undefined,
        },
      ],
    });
  });

  test("hasPermission forwards a bounded explicit ancestor chain atomically", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "allowed",
        effectiveRoleIds: [],
      }),
    };

    await expect(
      builders.hasPermission(ctx, {
        scopeId: "scope_1",
        permission: "app.tasks:update",
        resource: { type: "app.tasks", id: "task_1" },
        ancestors: [{ type: "app.projects", id: "project_1" }],
      }),
    ).resolves.toBe(true);

    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_1",
      permission: "app.tasks:update",
      resourceType: "app.tasks",
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
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

  test("filterAuthorizedResources includes rows allowed by an ancestor", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(async (_ref: string, args: { ancestors?: unknown[] }) => ({
        allowed: args.ancestors?.length === 1,
        reasonCode: "allowed",
        effectiveRoleIds: [],
      })),
    };

    const rows = [{ _id: "task_1", projectId: "project_1" }];
    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: rows,
      permission: "app.tasks:read",
      scopeId: "scope_1",
      resource: (row) => ({ type: "app.tasks", id: row._id }),
      ancestors: (row) => [{ type: "app.projects", id: row.projectId }],
    });

    expect(result).toEqual(rows);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_1",
      permission: "app.tasks:read",
      resourceType: "app.tasks",
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });

  test("filterAuthorizedResources excludes rows denied by an ancestor", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn().mockResolvedValue({
        allowed: false,
        reasonCode: "explicit_deny",
        effectiveRoleIds: [],
      }),
    };

    const result = await builders.filterAuthorizedResources(ctx as never, {
      resources: [{ _id: "task_1", projectId: "project_1" }],
      permission: "app.tasks:read",
      resource: (row) => ({ type: "app.tasks", id: row._id }),
      ancestors: (row) => [{ type: "app.projects", id: row.projectId }],
    });

    expect(result).toEqual([]);
    expect(ctx.runQuery).toHaveBeenCalledWith(
      "authorize",
      expect.objectContaining({
        ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
      }),
    );
  });

  test("filterAuthorizedResources returns [] when the caller is unauthenticated", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const ctx = {
      auth: { getUserIdentity: vi.fn().mockResolvedValue(null) },
      runQuery: vi.fn(),
    };
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
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery: vi.fn(),
    };

    await expect(handler.handler(ctx, {})).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  test("scopeFromResource reads the scope field from the loaded row", async () => {
    const extract = scopeFromResource("loans", "loanId");
    const ctx = {
      db: { get: vi.fn().mockResolvedValue({ orgScopeId: "scope_xyz" }) },
    };
    // The resource type defers to the checked permission's canonical catalog
    // type (sentinel substituted by the authorize gate), NOT the table name:
    // resource grants are pinned to the catalog type, so emitting the table
    // name would make every resource-scoped check deny.
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      scopeId: "scope_xyz",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "loan_1",
    });
    expect(ctx.db.get).toHaveBeenCalledWith("loan_1");
  });

  test("scopeFromResource accepts a custom scopeField", async () => {
    const extract = scopeFromResource("loans", "loanId", {
      scopeField: "accessScopeId",
    });
    const ctx = {
      db: { get: vi.fn().mockResolvedValue({ accessScopeId: "scope_custom" }) },
    };
    await expect(extract(ctx as never, { loanId: "loan_1" })).resolves.toEqual({
      scopeId: "scope_custom",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "loan_1",
    });
  });

  test("scopeFromResource throws when the row is missing the scope field", async () => {
    const extract = scopeFromResource("loans", "loanId");
    const ctx = { db: { get: vi.fn().mockResolvedValue({}) } };
    await expect(extract(ctx as never, { loanId: "loan_1" })).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("scopeFromResource hierarchy (authorizeAgainst)", () => {
  function makeTaskMutation(
    authorizeAgainst?: (row: Record<string, unknown>) => Array<{ type: string; id: string }>,
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
    } as never) as unknown as {
      handler: (ctx: unknown, args: unknown) => Promise<unknown>;
    };
  }

  function makeCtx(
    runQuery: ReturnType<typeof vi.fn>,
    row: Record<string, unknown> = {
      orgScopeId: "scope_1",
      projectId: "proj_1",
    },
  ) {
    return {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: "https://auth.example.com|user_1",
        }),
      },
      runQuery,
      db: { get: vi.fn().mockResolvedValue(row) },
    };
  }

  test("allows via an ancestor when the resource itself is implicitly denied", async () => {
    const handler = makeTaskMutation((task) => [
      {
        type: "app.project",
        id: String(task.projectId),
      },
    ]);
    const runQuery = vi.fn(async () => ({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    }));
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      scopeId: "scope_1",
      permission: "app.task:edit",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.project", resourceId: "proj_1" }],
    });
  });

  test("returns an atomic deny from the target and ancestor evaluation", async () => {
    const handler = makeTaskMutation((task) => [
      {
        type: "app.project",
        id: String(task.projectId),
      },
    ]);
    const runQuery = vi.fn().mockResolvedValue({
      allowed: false,
      reasonCode: "permission_denied",
      explicitDeny: true,
      effectiveRoleIds: [],
    });

    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).rejects.toBeInstanceOf(
      ConvexError,
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("always sends declared ancestors even when the target itself allows", async () => {
    const handler = makeTaskMutation((task) => [{ type: "app.project", id: String(task.projectId) }]);
    const runQuery = vi.fn().mockResolvedValue({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("default path without authorizeAgainst makes exactly one authorize call", async () => {
    const handler = makeTaskMutation();
    const runQuery = vi.fn().mockResolvedValue({
      allowed: true,
      reasonCode: "allowed",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).resolves.toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  test("rejects an over-long ancestor chain before any authorize call", async () => {
    const handler = makeTaskMutation(() =>
      Array.from({ length: 11 }, (_unused, i) => ({
        type: "app.project",
        id: `p${i}`,
      })),
    );
    const runQuery = vi.fn().mockResolvedValue({
      allowed: false,
      reasonCode: "denied",
      effectiveRoleIds: [],
    });
    await expect(handler.handler(makeCtx(runQuery), { taskId: "task_1" })).rejects.toBeInstanceOf(ConvexError);
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("scopeFromParentResource authorizes child creation against its loaded parent", async () => {
    const extract = scopeFromParentResource("projects", "projectId", {
      parentResourceType: "app.projects",
      authorizeAgainst: (project) => [{ type: "app.workspaces", id: String(project.workspaceId) }],
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          orgScopeId: "scope_1",
          workspaceId: "workspace_1",
        }),
      },
    };

    await expect(extract(ctx as never, { projectId: "project_1" })).resolves.toEqual({
      scopeId: "scope_1",
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: [
        { resourceType: "app.projects", resourceId: "project_1" },
        { resourceType: "app.workspaces", resourceId: "workspace_1" },
      ],
    });
  });
});

describe("default-scope resource extractors", () => {
  test("scopeFromDefaultResource loads a row without a stored scope id", async () => {
    const extract = scopeFromDefaultResource("documents", "documentId");
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "document_1", title: "Draft" }),
      },
    };

    await expect(extract(ctx as never, { documentId: "document_1" })).resolves.toEqual({
      scopeId: DEFAULT_SCOPE_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "document_1",
    });
  });

  test("scopeFromDefaultResource includes trusted ancestors from the loaded row", async () => {
    const extract = scopeFromDefaultResource("tasks", "taskId", {
      authorizeAgainst: (task) => [
        { type: "app.projects", id: String(task.projectId) },
      ],
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "task_1", projectId: "project_1" }),
      },
    };

    await expect(extract(ctx as never, { taskId: "task_1" })).resolves.toEqual({
      scopeId: DEFAULT_SCOPE_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: "task_1",
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });

  test("scopeFromDefaultParentResource authorizes creation against a loaded parent", async () => {
    const extract = scopeFromDefaultParentResource("projects", "projectId", {
      parentResourceType: "app.projects",
    });
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({ _id: "project_1", name: "Roadmap" }),
      },
    };

    await expect(extract(ctx as never, { projectId: "project_1" })).resolves.toEqual({
      scopeId: DEFAULT_SCOPE_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: [{ resourceType: "app.projects", resourceId: "project_1" }],
    });
  });
});
