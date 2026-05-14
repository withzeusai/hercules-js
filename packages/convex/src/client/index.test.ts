import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { ComponentApi } from "../_generated/component";
import { createAccessControl, type AccessControlComponent } from "./index";

const component = {
  checks: {
    authorize: "authorize",
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
        handler: async () => null,
      } as never),
    ).toThrow("access* builders require a non-empty permission.");
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
      runQuery: vi.fn().mockResolvedValue({
        allowed: false,
        reasonCode: "principal_suspended",
        effectiveRoleIds: [],
      }),
    };

    await expect(handler.handler(ctx)).rejects.toBeInstanceOf(ConvexError);
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      permission: undefined,
      targetType: undefined,
      targetId: undefined,
    });
  });

  test("access builders pass the permission to the component check", async () => {
    const builders = createAccessControl({
      query: identityBuilder,
      mutation: identityBuilder,
      action: identityBuilder,
      component: component as never,
    });
    const handler = builders.accessMutation({
      permission: "appointments:create",
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
        sourceVersion: 1,
        principalId: "principal_1",
        effectiveRoleIds: ["role_member"],
      }),
    };

    await expect(handler.handler(ctx)).resolves.toBe("ok");
    expect(ctx.runQuery).toHaveBeenCalledWith("authorize", {
      tokenIdentifier: "https://auth.example.com|user_1",
      permission: "appointments:create",
      targetType: undefined,
      targetId: undefined,
    });
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}
