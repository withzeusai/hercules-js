import { describe, expect, test, vi } from "vitest";
import { createIamManagementActions, createDeploymentEntryAction } from "./iam-management";
import { createIamServiceActions } from "./iam-service";

const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl";
const identityBuilder = ((definition: unknown) => definition) as never;

function getHandler(value: unknown) {
  return (
    value as {
      handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
    }
  ).handler;
}

describe("IAM action surfaces", () => {
  test("keeps deployment entry separate from IAM management", async () => {
    const post = vi.fn().mockResolvedValue({
      allowed: true,
      reason: "open_allowed",
      status: "active",
      principal_id: "principal_1",
      state_version: 3,
      changed: true,
      projection_ids: ["projection_1"],
    });
    const action = createDeploymentEntryAction({
      authenticatedAction: identityBuilder,
      client: { post },
    });
    const management = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await expect(getHandler(action)({}, { idToken: ID_TOKEN })).resolves.toMatchObject({
      allowed: true,
      status: "active",
      principalId: "principal_1",
    });
    expect(management).not.toHaveProperty("enterDeployment");
  });

  test("maps explicit user and principal recipients", async () => {
    const post = vi.fn().mockResolvedValue({ changed: true });
    const service = createIamServiceActions({
      internalAction: identityBuilder,
      client: { post },
    });
    const management = createIamManagementActions({
      authenticatedAction: identityBuilder,
      client: { post },
    });

    await getHandler(service.assignRole)(
      {},
      {
        scopeId: "scope_1",
        recipient: { type: "user", herculesAuthUserId: "user_1" },
        roleKey: "reviewer",
      },
    );
    await getHandler(management.assignRole)(
      {},
      {
        scopeId: "scope_1",
        recipient: { type: "principal", principalId: "principal_1" },
        roleKey: "reviewer",
        idToken: ID_TOKEN,
      },
    );

    expect(post).toHaveBeenNthCalledWith(1, "/v1/iam/roles/assign", {
      body: expect.objectContaining({
        hercules_auth_user_id: "user_1",
        actor_mode: "service",
      }),
    });
    expect(post).toHaveBeenNthCalledWith(2, "/v1/iam/roles/assign", {
      body: expect.objectContaining({
        principal_id: "principal_1",
        actor_mode: "app_user",
      }),
    });
    const serviceBody = post.mock.calls[0]?.[1].body;
    const managementBody = post.mock.calls[1]?.[1].body;
    expect(serviceBody).not.toHaveProperty("principal_id");
    expect(managementBody).not.toHaveProperty("hercules_auth_user_id");
  });
});
