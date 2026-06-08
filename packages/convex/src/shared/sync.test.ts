import { describe, expect, test } from "vitest";
import {
  accessProjectionEventSchema,
  accessProjectionSnapshotSchema,
  accessProjectionSyncPayloadSchema,
  emptyAccessProjectionEntities,
} from "./sync";

const defaultScope = {
  accessScopeId: "scope_default",
  name: "Default",
  kind: "default" as const,
  status: "active" as const,
  accountEntryMode: "open" as const,
  defaultRoleId: "role_member",
  updatedAt: 1,
};

describe("Access Control projection v3 schemas", () => {
  test("accepts an aggregate initialization snapshot", () => {
    const snapshot = {
      type: "access.projection.snapshot",
      schemaVersion: 3,
      eventId: "snapshot_1",
      mode: "initialize",
      sourceVersion: 1,
      expectedIssuer: "https://auth.example.com",
      scopes: [
        { scope: defaultScope, entities: emptyAccessProjectionEntities() },
      ],
    };

    expect(accessProjectionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(accessProjectionSyncPayloadSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("accepts one event containing multiple affected scopes", () => {
    const event = {
      type: "access.projection.event",
      schemaVersion: 3,
      eventId: "event_2",
      sourceVersion: 2,
      scopes: [
        {
          scope: defaultScope,
          changes: [
            {
              entityType: "permission",
              entityId: "perm_1",
              operation: "upsert",
            },
          ],
          entities: {
            ...emptyAccessProjectionEntities(),
            permissions: [
              {
                permissionId: "perm_1",
                accessScopeId: "scope_default",
                key: "app.tasks:read",
                resourceType: "app.tasks",
                action: "read",
                classification: "delegable",
                tenantAssignable: true,
                updatedAt: 2,
              },
            ],
          },
        },
        {
          scope: {
            ...defaultScope,
            accessScopeId: "scope_org",
            name: "Acme",
            kind: "org",
          },
          changes: [
            { entityType: "grant", entityId: "grant_1", operation: "delete" },
          ],
          entities: emptyAccessProjectionEntities(),
        },
      ],
    };

    expect(accessProjectionEventSchema.parse(event)).toEqual(event);
  });

  test("requires exactly one default scope first in a snapshot", () => {
    const result = accessProjectionSnapshotSchema.safeParse({
      type: "access.projection.snapshot",
      schemaVersion: 3,
      eventId: "snapshot_invalid",
      mode: "reset",
      sourceVersion: 2,
      expectedIssuer: "https://auth.example.com",
      scopes: [
        {
          scope: {
            ...defaultScope,
            accessScopeId: "scope_org",
            kind: "org",
          },
          entities: emptyAccessProjectionEntities(),
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  test("rejects duplicate event scopes and malformed grants", () => {
    const malformedScope = {
      scope: defaultScope,
      changes: [],
      entities: {
        ...emptyAccessProjectionEntities(),
        grants: [
          {
            grantId: "grant_1",
            subjectPrincipalId: "principal_1",
            subjectRoleId: "role_1",
            relationKind: "role",
            roleId: "role_1",
            effect: "allow",
            objectType: "scope",
            objectId: "scope_other",
            updatedAt: 1,
          },
        ],
      },
    };

    expect(
      accessProjectionEventSchema.safeParse({
        type: "access.projection.event",
        schemaVersion: 3,
        eventId: "event_invalid",
        sourceVersion: 2,
        scopes: [malformedScope, malformedScope],
      }).success,
    ).toBe(false);
  });

  test("rejects permissions without a delegation classification", () => {
    const result = accessProjectionSnapshotSchema.safeParse({
      type: "access.projection.snapshot",
      schemaVersion: 3,
      eventId: "snapshot_invalid",
      mode: "initialize",
      sourceVersion: 1,
      expectedIssuer: "https://auth.example.com",
      scopes: [
        {
          scope: defaultScope,
          entities: {
            ...emptyAccessProjectionEntities(),
            permissions: [
              {
                permissionId: "perm_1",
                accessScopeId: "scope_default",
                key: "app.tasks:read",
                resourceType: "app.tasks",
                action: "read",
                tenantAssignable: true,
                updatedAt: 1,
              },
            ],
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
