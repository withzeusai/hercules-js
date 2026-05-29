import { Webhook } from "standardwebhooks";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccessProjectionEvent, AccessProjectionSnapshot } from "../shared/sync";
import { registerAccessControlRoutes } from "./http";

const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;

const snapshot: AccessProjectionSnapshot = {
  type: "access.projection.snapshot",
  schemaVersion: 1,
  eventId: "evt_1",
  sourceVersion: 1,
  expectedIssuer: "https://auth.example.com",
  scope: {
    accessScopeId: "scope_1",
    name: "Default",
    kind: "default",
    status: "active",
    accountEntryMode: "open",
    defaultRoleId: "role_member",
    updatedAt: 1,
  },
  entities: {
    principals: [],
    principalMemberships: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    grants: [],
  },
};

const event: AccessProjectionEvent = {
  type: "access.projection.event",
  schemaVersion: 1,
  eventId: "evt_2",
  sourceVersion: 2,
  scope: {
    accessScopeId: "scope_1",
    name: "Default",
    kind: "default",
    status: "active",
    accountEntryMode: "open",
    defaultRoleId: "role_member",
    updatedAt: 2,
  },
  changes: [{ entityType: "permission", entityId: "permission_1", operation: "upsert" }],
  entities: {
    principals: [],
    principalMemberships: [],
    roles: [],
    permissions: [
      {
        permissionId: "permission_1",
        accessScopeId: "scope_default",
        key: "tasks:create",
        resourceType: "tasks",
        action: "create",
        tenantAssignable: true,
        updatedAt: 1,
      },
    ],
    rolePermissions: [],
    grants: [],
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
    const routes: Array<{ path: string; method: string; handler: Function }> = [];
    registerAccessControlRoutes(
      { route: (route: { path: string; method: string; handler: Function }) => routes.push(route) },
      {
        httpAction: (handler) => handler as never,
        components: { hercules: { sync: { applySync: "herculesApplySync" } } },
      },
    );
    const runMutation = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "applied", acknowledgedVersion: 1 });

    await routes[0]!.handler({ runMutation }, signedRequest(JSON.stringify(snapshot)));

    expect(runMutation).toHaveBeenCalledWith("herculesApplySync", snapshot);
  });

  test("continues resolving legacy accessControl mounts", async () => {
    const routes: Array<{ path: string; method: string; handler: Function }> = [];
    registerAccessControlRoutes(
      { route: (route: { path: string; method: string; handler: Function }) => routes.push(route) },
      {
        httpAction: (handler) => handler as never,
        components: { accessControl: { sync: { applySync: "legacyApplySync" } } },
      },
    );
    const runMutation = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "applied", acknowledgedVersion: 1 });

    await routes[0]!.handler({ runMutation }, signedRequest(JSON.stringify(snapshot)));

    expect(runMutation).toHaveBeenCalledWith("legacyApplySync", snapshot);
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
});

function registerRouteForTest() {
  const routes: Array<{ path: string; method: string; handler: Function }> = [];
  registerAccessControlRoutes(
    { route: (route: { path: string; method: string; handler: Function }) => routes.push(route) },
    {
      httpAction: (handler) => handler as never,
      component: { sync: { applySync: "applySync" as never } },
    },
  );
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
