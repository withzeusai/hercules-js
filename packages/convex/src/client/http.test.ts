import type { HttpRouter } from "convex/server";
import { Webhook } from "standardwebhooks";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccessProjectionEvent, AccessProjectionSnapshot } from "../shared/sync";
import { registerAccessControlRoutes } from "./http";

// A captured route's shape, narrowed to what the tests invoke. The handler is
// called with a fake `{ runMutation }` ctx and a Request, returning a Response.
type TestRoute = {
  path: string;
  method: string;
  handler: (
    ctx: { runMutation: (...args: never[]) => unknown },
    request: Request,
  ) => Promise<Response>;
};

// Build a fake HttpRouter whose `route` records every spec, cast through the
// real HttpRouter type so registerAccessControlRoutes type-checks against the
// production signature while the test keeps a plain array of captured routes.
function collectRoutes(): { router: HttpRouter; routes: TestRoute[] } {
  const routes: TestRoute[] = [];
  const router = {
    route: (spec: TestRoute) => {
      routes.push(spec);
    },
  } as unknown as HttpRouter;
  return { router, routes };
}

const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;

const snapshot: AccessProjectionSnapshot = {
  type: "access.projection.snapshot",
  schemaVersion: 3,
  eventId: "evt_1",
  mode: "initialize",
  sourceVersion: 1,
  expectedIssuer: "https://auth.example.com",
  catalog: { roles: [], permissions: [], rolePermissions: [] },
  users: [],
  scopes: [
    {
      scope: {
        accessScopeId: "scope_1",
        name: "Default",
        kind: "default",
        status: "active",
        accountEntryMode: "open",
        defaultRoleId: "role_member",
        updatedAt: 1,
      },
      principals: [],
      principalMemberships: [],
      roles: [],
      rolePermissionOverrides: [],
      roleBindings: [],
      permissionBindings: [],
    },
  ],
};

const event: AccessProjectionEvent = {
  type: "access.projection.event",
  schemaVersion: 3,
  eventId: "evt_2",
  sourceVersion: 2,
  catalog: {
    changes: [{ entityType: "permission", permissionId: "permission_1", operation: "upsert" }],
    roles: [],
    permissions: [
      {
        permissionId: "permission_1",
        key: "tasks:create",
        resourceType: "tasks",
        action: "create",
        classification: "delegable",
        tenantAssignable: true,
        updatedAt: 1,
      },
    ],
    rolePermissions: [],
  },
};

describe("registerAccessControlRoutes", () => {
  beforeEach(() => {
    process.env.HERCULES_SYNC_SECRET = secret;
  });

  test("applies a signed snapshot", async () => {
    const route = registerRouteForTest();
    const runMutation = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "applied", acknowledgedVersion: 1 });

    const response = await route.handler({ runMutation }, signedRequest(JSON.stringify(snapshot)));

    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "applied",
      acknowledgedVersion: 1,
    });
    expect(response.status).toBe(200);
    expect(runMutation).toHaveBeenCalledWith("applySync", snapshot);
  });

  test("applies a signed incremental event", async () => {
    const route = registerRouteForTest();
    const runMutation = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "applied", acknowledgedVersion: 2 });

    const response = await route.handler({ runMutation }, signedRequest(JSON.stringify(event)));

    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "applied",
      acknowledgedVersion: 2,
    });
    expect(response.status).toBe(200);
    expect(runMutation).toHaveBeenCalledWith("applySync", event);
  });

  test("resolves the Hercules-mounted component by default", async () => {
    const { router, routes } = collectRoutes();
    registerAccessControlRoutes(router, {
      httpAction: (handler) => handler as never,
      components: { hercules: { sync: { applySync: "herculesApplySync" } } },
    });
    const runMutation = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "applied", acknowledgedVersion: 1 });

    await routes[0]!.handler({ runMutation }, signedRequest(JSON.stringify(snapshot)));

    expect(runMutation).toHaveBeenCalledWith("herculesApplySync", snapshot);
  });

  test("rejects an unsigned snapshot", async () => {
    const route = registerRouteForTest();
    const runMutation = vi.fn();

    const response = await route.handler(
      { runMutation },
      new Request("https://example.com", { method: "POST", body: JSON.stringify(snapshot) }),
    );

    await expect(response.json()).resolves.toEqual({ ok: false, status: "invalid_signature" });
    expect(response.status).toBe(401);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("rejects an invalid signed payload", async () => {
    const route = registerRouteForTest();
    const runMutation = vi.fn();

    const response = await route.handler(
      { runMutation },
      signedRequest(JSON.stringify({ type: "unexpected" })),
    );

    await expect(response.json()).resolves.toEqual({ ok: false, status: "invalid_payload" });
    expect(response.status).toBe(400);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test.each([
    [{ ok: false, status: "not_ready", currentVersion: 0 }, 409],
    [{ ok: false, status: "reset_required", currentVersion: 4 }, 409],
    [
      {
        ok: false,
        status: "version_gap",
        currentVersion: 4,
        expectedVersion: 5,
        receivedVersion: 6,
      },
      409,
    ],
    [{ ok: false, status: "issuer_mismatch" }, 409],
    [{ ok: false, status: "default_scope_required" }, 400],
    [{ ok: false, status: "invalid_payload" }, 400],
  ] as const)("maps %s to HTTP %i", async (result, expectedStatus) => {
    const route = registerRouteForTest();
    const response = await route.handler(
      { runMutation: vi.fn().mockResolvedValue(result) },
      signedRequest(JSON.stringify(snapshot)),
    );

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual(result);
  });
});

function registerRouteForTest() {
  const { router, routes } = collectRoutes();
  registerAccessControlRoutes(router, {
    httpAction: (handler) => handler as never,
    component: { sync: { applySync: "applySync" as never } },
  });
  return routes[0]!;
}

function signedRequest(rawBody: string) {
  const webhook = new Webhook(secret);
  const timestamp = new Date();
  return new Request("https://example.com", {
    method: "POST",
    body: rawBody,
    headers: {
      "webhook-id": "evt_1",
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": webhook.sign("evt_1", timestamp, rawBody),
    },
  });
}
