import { describe, expect, test, vi } from "vitest";
import { createAccessAdminActions } from "./access-admin";

describe("createAccessAdminActions", () => {
  test("uses generated SDK methods when available", async () => {
    const assign = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: {
        post: vi.fn(),
        accessControl: { roles: { assign } },
      },
    });

    await expect(
      getHandler(actions.assignRole)({}, { scopeId: "scope_1", roleKey: "admin" }),
    ).resolves.toEqual({ changed: true });

    expect(assign).toHaveBeenCalledWith({
      scope_id: "scope_1",
      principal_id: undefined,
      hercules_auth_user_id: undefined,
      role_id: undefined,
      role_key: "admin",
    });
  });

  test("falls back to low-level SDK post until generated methods exist", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const actions = createAccessAdminActions({
      accessAction: identityBuilder,
      client: { post },
    });

    await expect(
      getHandler(actions.setUserExceptions)(
        {},
        {
          scopeId: "scope_1",
          herculesAuthUserId: "user_1",
          allow: ["reports.export"],
          deny: [],
        },
      ),
    ).resolves.toEqual({ changed: true });

    expect(post).toHaveBeenCalledWith("/v1/access-control/user-exceptions/set", {
      body: {
        scope_id: "scope_1",
        principal_id: undefined,
        hercules_auth_user_id: "user_1",
        allow: ["reports.export"],
        deny: [],
      },
    });
  });
});

function identityBuilder(definition: unknown) {
  return definition;
}

function getHandler(value: unknown) {
  return (value as { handler: (ctx: unknown, args: Record<string, unknown>) => unknown }).handler;
}
