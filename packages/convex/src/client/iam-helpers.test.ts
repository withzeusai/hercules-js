import { describe, expect, test, vi } from "vitest";
import type { GrantCreateResponse } from "@usehercules/sdk/resources/iam/tenants/resources/grants";
import type { FunctionReference } from "convex/server";
import type { ComponentApi } from "../_generated/component";
import {
  createResourceCreatorBootstrapAction,
  type ResourceCreatorBootstrapActivationArgs,
  type ResourceCreatorBootstrapClient,
  type ResourceCreatorBootstrapTarget,
  type ResourceCreatorBootstrapTenantPage,
} from "./iam-helpers";

const authenticatedAction = ((definition: unknown) => definition) as never;
const getBootstrapTarget = "internal.projects.getBootstrapTarget" as unknown as FunctionReference<
  "query",
  "internal",
  { resourceId: string },
  ResourceCreatorBootstrapTarget | null
>;
const listMyTenants =
  "components.hercules.queries.listMyTenants" as unknown as ComponentApi["queries"]["listMyTenants"];
const activateResource = "internal.projects.activateResource" as unknown as FunctionReference<
  "mutation",
  "internal",
  ResourceCreatorBootstrapActivationArgs,
  void
>;

const rawGrant: GrantCreateResponse = {
  tenant_id: "tenant_1",
  changed: true,
  source_version: 4,
  projection_ids: ["projection_1"],
  grant: {
    grant_id: "grant_1",
    type: "resource_role",
    role_id: "role_1",
    expires_at: null,
    applies_to: "self_and_descendants",
  },
};

const normalizedGrant = {
  tenantId: "tenant_1",
  changed: true,
  sourceVersion: 4,
  projectionIds: ["projection_1"],
  grant: {
    grantId: "grant_1",
    type: "resource_role",
    roleId: "role_1",
    expiresAt: null,
    appliesTo: "self_and_descendants",
  },
};

function getHandler(value: unknown) {
  return (
    value as {
      handler: (ctx: ReturnType<typeof makeCtx>, args: { resourceId: string }) => Promise<unknown>;
    }
  ).handler;
}

function makeClient() {
  const create = vi.fn().mockResolvedValue(rawGrant);
  return {
    client: {
      iam: {
        tenants: {
          resources: {
            grants: { create },
          },
        },
      },
    } satisfies ResourceCreatorBootstrapClient,
    create,
  };
}

function makeCtx(options: {
  identity?: { tokenIdentifier?: string; subject?: string } | null;
  target?: unknown;
  tenantPages?: ResourceCreatorBootstrapTenantPage[];
}) {
  const tenantPages = [...(options.tenantPages ?? [{ tenants: [] }])];
  const identity =
    "identity" in options
      ? options.identity
      : {
          tokenIdentifier: "https://issuer.example|user_1",
          subject: "user_1",
        };
  const target =
    "target" in options
      ? options.target
      : {
          tenantId: "tenant_1",
          resourceId: "project_1",
          creatorHerculesAuthUserId: "user_1",
          state: "provisioning",
        };
  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(identity),
    },
    runQuery: vi.fn(async (ref: unknown, args: unknown) => {
      if (ref === getBootstrapTarget) {
        return target;
      }
      if (ref === listMyTenants) {
        return tenantPages.shift() ?? { tenants: [] };
      }
      throw new Error(`Unexpected query reference ${String(ref)} with ${JSON.stringify(args)}`);
    }),
    runMutation: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAction(client: ResourceCreatorBootstrapClient) {
  return createResourceCreatorBootstrapAction({
    authenticatedAction,
    resourceType: "app.projects",
    managerRole: { key: "project_manager" },
    appliesTo: "self_and_descendants",
    getBootstrapTarget,
    listMyTenants,
    activateResource,
    client,
  });
}

describe("resource creator bootstrap", () => {
  test("grants the trusted creator once with service authority and activates the row", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "active" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).resolves.toEqual({
      resourceId: "project_1",
      state: "active",
      bootstrapped: true,
      grant: normalizedGrant,
    });

    expect(ctx.auth.getUserIdentity).toHaveBeenCalledTimes(1);
    expect(ctx.runQuery).toHaveBeenNthCalledWith(1, getBootstrapTarget, {
      resourceId: "project_1",
    });
    expect(ctx.runQuery).toHaveBeenNthCalledWith(2, listMyTenants, {
      tokenIdentifier: "https://issuer.example|user_1",
      cursor: undefined,
      limit: 100,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("project_1", {
      tenant_id: "tenant_1",
      resource_type: "app.projects",
      user_token_identifier: null,
      subject: { type: "user", user_id: "user_1" },
      role: { key: "project_manager" },
      applies_to: "self_and_descendants",
    });
    expect(ctx.runMutation).toHaveBeenCalledWith(activateResource, {
      resourceId: "project_1",
      creatorHerculesAuthUserId: "user_1",
      grant: normalizedGrant,
    });
  });

  test("does not grant or activate an already-active resource", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      target: {
        tenantId: "tenant_1",
        resourceId: "project_1",
        creatorHerculesAuthUserId: "user_1",
        state: "active",
      },
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "active" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).resolves.toEqual({
      resourceId: "project_1",
      state: "active",
      bootstrapped: false,
    });
    expect(create).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("denies a creator mismatch before any grant call", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      target: {
        tenantId: "tenant_1",
        resourceId: "project_1",
        creatorHerculesAuthUserId: "user_2",
        state: "provisioning",
      },
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "active" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test.each([
    ["a missing bootstrap target", null],
    [
      "a target for another resource",
      {
        tenantId: "tenant_1",
        resourceId: "project_2",
        creatorHerculesAuthUserId: "user_1",
        state: "provisioning",
      },
    ],
  ])("denies %s before any grant call", async (_case, target) => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({ target });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("denies inactive tenant membership before any grant call", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "pending_approval" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toMatchObject({
      data: { code: "ACCESS_DENIED" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("walks tenant pages before granting", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      tenantPages: [
        { tenants: [{ tenantId: "tenant_0", status: "active" }], cursor: "cursor_1" },
        { tenants: [{ tenantId: "tenant_1", status: "active" }] },
      ],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).resolves.toMatchObject({
      bootstrapped: true,
    });
    expect(ctx.runQuery).toHaveBeenNthCalledWith(3, listMyTenants, {
      tokenIdentifier: "https://issuer.example|user_1",
      cursor: "cursor_1",
      limit: 100,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("retries activation after an idempotent grant create reports unchanged", async () => {
    const idempotentRawGrant = {
      ...rawGrant,
      changed: false,
    };
    const idempotentNormalizedGrant = {
      ...normalizedGrant,
      changed: false,
    };
    const { client, create } = makeClient();
    create.mockResolvedValueOnce(rawGrant).mockResolvedValueOnce(idempotentRawGrant);
    const action = makeAction(client);
    const ctx = makeCtx({
      tenantPages: [
        { tenants: [{ tenantId: "tenant_1", status: "active" }] },
        { tenants: [{ tenantId: "tenant_1", status: "active" }] },
      ],
    });
    ctx.runMutation.mockRejectedValueOnce(new Error("activation failed"));

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toThrow(
      "activation failed",
    );
    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).resolves.toEqual({
      resourceId: "project_1",
      state: "active",
      bootstrapped: true,
      grant: idempotentNormalizedGrant,
    });

    expect(ctx.runQuery).toHaveBeenNthCalledWith(1, getBootstrapTarget, {
      resourceId: "project_1",
    });
    expect(ctx.runQuery).toHaveBeenNthCalledWith(3, getBootstrapTarget, {
      resourceId: "project_1",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, "project_1", {
      tenant_id: "tenant_1",
      resource_type: "app.projects",
      user_token_identifier: null,
      subject: { type: "user", user_id: "user_1" },
      role: { key: "project_manager" },
      applies_to: "self_and_descendants",
    });
    expect(create).toHaveBeenNthCalledWith(2, "project_1", {
      tenant_id: "tenant_1",
      resource_type: "app.projects",
      user_token_identifier: null,
      subject: { type: "user", user_id: "user_1" },
      role: { key: "project_manager" },
      applies_to: "self_and_descendants",
    });
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(1, activateResource, {
      resourceId: "project_1",
      creatorHerculesAuthUserId: "user_1",
      grant: normalizedGrant,
    });
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, activateResource, {
      resourceId: "project_1",
      creatorHerculesAuthUserId: "user_1",
      grant: idempotentNormalizedGrant,
    });
  });

  test("rejects a non-resource-role SDK grant response", async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({
      ...rawGrant,
      grant: {
        ...rawGrant.grant,
        type: "role",
      },
    });
    const action = makeAction(client);
    const ctx = makeCtx({
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "active" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toThrow(
      "Hercules IAM response has invalid resource grant type.",
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("requires a matching Convex identity subject", async () => {
    const { client, create } = makeClient();
    const action = makeAction(client);
    const ctx = makeCtx({
      identity: {
        tokenIdentifier: "https://issuer.example|user_1",
        subject: "user_2",
      },
      tenantPages: [{ tenants: [{ tenantId: "tenant_1", status: "active" }] }],
    });

    await expect(getHandler(action)(ctx, { resourceId: "project_1" })).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
