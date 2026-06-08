type LegacyEntities = {
  users: Array<Record<string, unknown>>;
  principals: Array<Record<string, unknown>>;
  principalMemberships: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  rolePermissions: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
};

type LegacyScope = {
  accessScopeId: string;
  name: string;
  kind: "default" | "org" | "suite";
  status: "active" | "disabled";
  accountEntryMode:
    | "open"
    | "allowlisted_only"
    | "invite_only"
    | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

type LegacySnapshot = {
  type: "access.projection.snapshot";
  schemaVersion: number;
  eventId: string;
  sourceVersion: number;
  expectedIssuer: string;
  scope: LegacyScope;
  entities: LegacyEntities;
};

type LegacyEvent = {
  type: "access.projection.event";
  schemaVersion: number;
  eventId: string;
  sourceVersion: number;
  scope: LegacyScope;
  changes: Array<Record<string, unknown>>;
  entities: LegacyEntities;
};

const emptyEntities = (): LegacyEntities => ({
  users: [],
  principals: [],
  principalMemberships: [],
  roles: [],
  permissions: [],
  rolePermissions: [],
  grants: [],
});

/**
 * Keeps pre-v3 behavioral fixtures useful while exercising the v3-only
 * runtime. This adapter is test-only and never ships in the package.
 */
export function withV3SyncFixtures<
  T extends { mutation: (...args: never[]) => unknown },
>(target: T): T {
  const snapshots = new Map<
    string,
    { scope: LegacyScope; entities: LegacyEntities }
  >();
  let initialized = false;
  const mutation = target.mutation.bind(target);

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== "mutation")
        return Reflect.get(object, property, receiver);
      return async (reference: unknown, payload: unknown) => {
        const upgraded = upgradePayload(payload);
        const result = await (
          mutation as (...args: unknown[]) => Promise<unknown>
        )(reference, upgraded);
        if (
          upgraded &&
          typeof upgraded === "object" &&
          (upgraded as { type?: string }).type ===
            "access.projection.snapshot" &&
          (result as { ok?: boolean }).ok
        ) {
          initialized = true;
        }
        return result;
      };
    },
  });

  function upgradePayload(payload: unknown): unknown {
    if (!isLegacyPayload(payload) || payload.schemaVersion !== 2)
      return payload;
    if (payload.type === "access.projection.event")
      return upgradeEvent(payload);

    snapshots.set(payload.scope.accessScopeId, {
      scope: payload.scope,
      entities: payload.entities,
    });
    return {
      type: payload.type,
      schemaVersion: 3,
      eventId: payload.eventId,
      mode: initialized ? "reset" : "initialize",
      sourceVersion: payload.sourceVersion,
      expectedIssuer: payload.expectedIssuer,
      scopes: aggregateScopes(),
    };
  }

  function upgradeEvent(payload: LegacyEvent) {
    snapshots.set(payload.scope.accessScopeId, {
      scope: payload.scope,
      entities: mergeEntities(
        snapshots.get(payload.scope.accessScopeId)?.entities ?? emptyEntities(),
        payload,
      ),
    });
    const defaultScope = ensureDefaultScope();
    const normalized = normalizeEntities(
      payload.entities,
      defaultScope.accessScopeId,
    );
    return {
      type: payload.type,
      schemaVersion: 3,
      eventId: payload.eventId,
      sourceVersion: payload.sourceVersion,
      scopes: [
        {
          scope: payload.scope,
          changes: payload.changes,
          entities: normalized,
        },
      ],
    };
  }

  function aggregateScopes() {
    const defaultScope = ensureDefaultScope();
    const aggregate = new Map<
      string,
      { scope: LegacyScope; entities: LegacyEntities }
    >();
    for (const entry of snapshots.values()) {
      aggregate.set(entry.scope.accessScopeId, {
        scope: entry.scope,
        entities: emptyEntities(),
      });
    }
    if (!aggregate.has(defaultScope.accessScopeId)) {
      aggregate.set(defaultScope.accessScopeId, {
        scope: defaultScope,
        entities: emptyEntities(),
      });
    }

    for (const entry of snapshots.values()) {
      const source = normalizeEntities(
        entry.entities,
        defaultScope.accessScopeId,
      );
      const target = aggregate.get(entry.scope.accessScopeId)!.entities;
      target.users.push(...source.users);
      target.principals.push(...source.principals);
      target.principalMemberships.push(...source.principalMemberships);
      target.grants.push(...source.grants);

      for (const role of source.roles) {
        const roleScopeId =
          role.kind === "system"
            ? defaultScope.accessScopeId
            : entry.scope.accessScopeId;
        aggregate.get(roleScopeId)!.entities.roles.push({
          ...role,
          accessScopeId: roleScopeId,
        });
      }
      aggregate.get(defaultScope.accessScopeId)!.entities.permissions.push(
        ...source.permissions.map((permission) => ({
          ...permission,
          accessScopeId: defaultScope.accessScopeId,
        })),
      );
      for (const rolePermission of source.rolePermissions) {
        const rolePermissionScopeId = String(rolePermission.accessScopeId);
        const owner =
          aggregate.get(rolePermissionScopeId) ??
          aggregate.get(entry.scope.accessScopeId)!;
        owner.entities.rolePermissions.push(rolePermission);
      }
    }

    return [...aggregate.values()].sort((left, right) => {
      if (left.scope.kind === "default") return -1;
      if (right.scope.kind === "default") return 1;
      return left.scope.accessScopeId.localeCompare(right.scope.accessScopeId);
    });
  }

  function ensureDefaultScope(): LegacyScope {
    const existing = [...snapshots.values()].find(
      (entry) => entry.scope.kind === "default",
    );
    if (existing) return existing.scope;
    const scope: LegacyScope = {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accountEntryMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 0,
    };
    snapshots.set(scope.accessScopeId, { scope, entities: emptyEntities() });
    return scope;
  }
}

function normalizeEntities(
  entities: LegacyEntities,
  defaultScopeId: string,
): LegacyEntities {
  return {
    users: entities.users.map((row) => ({ ...row })),
    principals: entities.principals.map((row) => ({ ...row })),
    principalMemberships: entities.principalMemberships.map((row) => ({
      ...row,
    })),
    roles: entities.roles.map((row) => ({
      ...row,
      accessScopeId: row.kind === "system" ? defaultScopeId : row.accessScopeId,
    })),
    permissions: entities.permissions.map((row) => ({
      ...row,
      accessScopeId: defaultScopeId,
      classification: row.classification ?? "delegable",
    })),
    rolePermissions: entities.rolePermissions.map((row) => ({ ...row })),
    grants: entities.grants.map((row) => ({ ...row })),
  };
}

function mergeEntities(
  current: LegacyEntities,
  event: LegacyEvent,
): LegacyEntities {
  const next = normalizeEntities(current, "scope_default");
  const incoming = normalizeEntities(event.entities, "scope_default");
  for (const user of incoming.users)
    upsert(next.users, user, "herculesAuthUserId");
  for (const change of event.changes) {
    const entityType = String(change.entityType);
    const entityId = String(change.entityId);
    const operation = String(change.operation);
    const collection = collectionForEntityType(next, entityType);
    if (!collection) continue;
    if (operation === "delete") {
      const index = collection.findIndex(
        (row) => entityIdFor(entityType, row) === entityId,
      );
      if (index >= 0) collection.splice(index, 1);
      continue;
    }
    const incomingCollection = collectionForEntityType(incoming, entityType);
    const row = incomingCollection?.find(
      (candidate) => entityIdFor(entityType, candidate) === entityId,
    );
    if (row) upsertByEntityId(collection, row, entityType);
  }
  return next;
}

function collectionForEntityType(entities: LegacyEntities, entityType: string) {
  switch (entityType) {
    case "principal":
      return entities.principals;
    case "principal_membership":
      return entities.principalMemberships;
    case "role":
      return entities.roles;
    case "permission":
      return entities.permissions;
    case "role_permission":
      return entities.rolePermissions;
    case "grant":
      return entities.grants;
    default:
      return undefined;
  }
}

function entityIdFor(entityType: string, row: Record<string, unknown>): string {
  switch (entityType) {
    case "principal":
      return String(row.principalId);
    case "principal_membership":
      return `${String(row.groupPrincipalId)}:${String(row.memberPrincipalId)}`;
    case "role":
      return String(row.roleId);
    case "permission":
      return String(row.permissionId);
    case "role_permission":
      return `${String(row.roleId)}:${String(row.permissionId)}:${String(row.effect)}`;
    case "grant":
      return String(row.grantId);
    default:
      return "";
  }
}

function upsert(
  rows: Array<Record<string, unknown>>,
  row: Record<string, unknown>,
  key: string,
) {
  const index = rows.findIndex((candidate) => candidate[key] === row[key]);
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

function upsertByEntityId(
  rows: Array<Record<string, unknown>>,
  row: Record<string, unknown>,
  entityType: string,
) {
  const id = entityIdFor(entityType, row);
  const index = rows.findIndex(
    (candidate) => entityIdFor(entityType, candidate) === id,
  );
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

function isLegacyPayload(
  payload: unknown,
): payload is LegacySnapshot | LegacyEvent {
  return (
    payload !== null &&
    typeof payload === "object" &&
    ((payload as { type?: string }).type === "access.projection.snapshot" ||
      (payload as { type?: string }).type === "access.projection.event") &&
    "scope" in payload
  );
}
