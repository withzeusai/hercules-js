// Test-only adapter: upgrades pre-v3 (schemaVersion 2) behavioral fixtures into
// the FINAL v3 projection wire shape so the existing behavioral suites
// (checks.test.ts, queries.test.ts) keep exercising the real applySync ->
// schema -> effective -> authorize pipeline without re-authoring every fixture.
//
// It is a faithful, mechanical translation of the old per-scope `entities`
// model into the v3 layout the producer now ships:
//   • the deployment-wide CATALOG (system/iam roles, permissions, base
//     role->permission map) and USERS lift to the TOP LEVEL,
//   • each scope keeps only its runtime state (principals, memberships, tenant
//     roles, per-scope role-permission OVERRIDES, role bindings, permission
//     bindings),
//   • the old polymorphic `grants` array splits into role_bindings (relationKind
//     "role") and permission_bindings (relationKind "direct_permission"), with
//     (objectType, objectId, objectResourceType) collapsing to the nullable
//     (resourceType, resourceId) target tuple,
//   • a role's intrinsic `baseWildcard` is carried verbatim (the old fixtures
//     already set `wildcard`), and per-scope role-permission rows whose
//     accessScopeId is NOT the default scope become role_permission_overrides.
//
// This adapter NEVER ships in the package. It produces the same wire shape the
// real producer does, so a mis-translation surfaces as a failing behavioral
// assertion (the real pipeline computes the decision) rather than a false pass.

type LegacyRole = {
  roleId: string;
  accessScopeId?: string;
  key: string;
  kind: string;
  source?: string;
  name?: string;
  wildcard?: "none" | "immutable" | "default";
  updatedAt: number;
};

type LegacyPermission = {
  permissionId: string;
  accessScopeId?: string;
  key: string;
  resourceType: string;
  action: string;
  classification?: "delegable" | "owner_only";
  tenantAssignable?: boolean;
  updatedAt: number;
};

type LegacyRolePermission = {
  roleId: string;
  permissionId: string;
  accessScopeId?: string;
  effect: "allow" | "deny";
  updatedAt: number;
};

type LegacyGrant = {
  grantId: string;
  subjectPrincipalId?: string;
  subjectRoleId?: string;
  relationKind: "role" | "direct_permission";
  roleId?: string;
  permissionId?: string;
  effect?: "allow" | "deny";
  objectType: "scope" | "resource";
  objectId?: string;
  objectResourceType?: string;
  appliesTo?: "self" | "self_and_descendants";
  expiresAt?: number;
  updatedAt: number;
};

type LegacyEntities = {
  users: Array<Record<string, unknown>>;
  principals: Array<Record<string, unknown>>;
  principalMemberships: Array<Record<string, unknown>>;
  roles: LegacyRole[];
  permissions: LegacyPermission[];
  rolePermissions: LegacyRolePermission[];
  grants: LegacyGrant[];
};

type LegacyScope = {
  accessScopeId: string;
  name: string;
  kind: "default" | "org" | "suite";
  status: "active" | "disabled";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

export type LegacySnapshot = {
  type: "access.projection.snapshot";
  schemaVersion: number;
  eventId: string;
  sourceVersion: number;
  expectedIssuer: string;
  scope: LegacyScope;
  entities: LegacyEntities;
};

export type LegacyEvent = {
  type: "access.projection.event";
  schemaVersion: number;
  eventId: string;
  sourceVersion: number;
  scope: LegacyScope;
  changes: Array<Record<string, unknown>>;
  entities: LegacyEntities;
};

export type LegacyPayload = LegacySnapshot | LegacyEvent;

const emptyEntities = (): LegacyEntities => ({
  users: [],
  principals: [],
  principalMemberships: [],
  roles: [],
  permissions: [],
  rolePermissions: [],
  grants: [],
});

// A catalog role is a deployment-wide reusable role (system/iam). A tenant role
// (kind org/custom) is owned by its scope. The old fixtures encode reusable
// roles as kind "system"/"default"/"iam"; tenant roles as kind "org"/"custom".
// `kind` is authoritative — a tenant role pinned to the default scope is still a
// tenant role, so the accessScopeId is NOT used to classify.
function isCatalogRole(role: LegacyRole, _defaultScopeId: string): boolean {
  void _defaultScopeId;
  if (role.kind === "system" || role.kind === "default" || role.kind === "iam") return true;
  if (role.source === "iam" || role.source === "system") return true;
  return false;
}

function catalogRoleSource(role: LegacyRole): "system" | "iam" {
  return role.source === "iam" ? "iam" : "system";
}

function baseWildcardFor(role: LegacyRole): "none" | "immutable" | "default" {
  if (role.wildcard === "immutable") return "immutable";
  if (role.wildcard === "default") return "default";
  return "none";
}

// The wrapped TestConvex: identical to the base, except `mutation` additionally
// accepts a legacy (schemaVersion 2) payload as its second argument (the adapter
// upgrades it to v3 before forwarding). Everything else passes through unchanged.
export type WithV3SyncFixtures<T extends { mutation: (...args: never[]) => unknown }> = Omit<
  T,
  "mutation"
> & { mutation: T["mutation"] & ((reference: never, payload: LegacyPayload) => Promise<unknown>) };

/**
 * Keeps pre-v3 behavioral fixtures useful while exercising the v3-only runtime.
 * This adapter is test-only and never ships in the package.
 */
export function withV3SyncFixtures<T extends { mutation: (...args: never[]) => unknown }>(
  target: T,
): WithV3SyncFixtures<T> {
  // Per-scope accumulator of the latest entities/scope seen, so a multi-scope
  // bootstrap (scope A snapshot then scope B snapshot) re-aggregates into one v3
  // snapshot, matching the old per-scope-snapshot behavior the fixtures rely on.
  const scopeStates = new Map<string, { scope: LegacyScope; entities: LegacyEntities }>();
  let initialized = false;
  const mutation = target.mutation.bind(target);

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== "mutation") return Reflect.get(object, property, receiver);
      return async (reference: unknown, payload: unknown) => {
        const upgraded = upgradePayload(payload);
        const result = await (mutation as (...args: unknown[]) => Promise<unknown>)(
          reference,
          upgraded,
        );
        if (
          upgraded &&
          typeof upgraded === "object" &&
          (upgraded as { type?: string }).type === "access.projection.snapshot" &&
          (result as { ok?: boolean }).ok
        ) {
          initialized = true;
        }
        return result;
      };
    },
  }) as unknown as WithV3SyncFixtures<T>;

  function upgradePayload(payload: unknown): unknown {
    if (!isLegacyPayload(payload) || payload.schemaVersion !== 2) return payload;
    if (payload.type === "access.projection.event") return upgradeEvent(payload);
    return upgradeSnapshot(payload);
  }

  function upgradeSnapshot(payload: LegacySnapshot) {
    scopeStates.set(payload.scope.accessScopeId, {
      scope: payload.scope,
      entities: payload.entities,
    });
    const defaultScope = ensureDefaultScope();
    const { catalog, users } = buildCatalogAndUsers(defaultScope.accessScopeId);
    return {
      type: payload.type,
      schemaVersion: 3,
      eventId: payload.eventId,
      mode: initialized ? "reset" : "initialize",
      sourceVersion: payload.sourceVersion,
      expectedIssuer: payload.expectedIssuer,
      catalog,
      users,
      scopes: buildScopes(defaultScope.accessScopeId),
    };
  }

  function upgradeEvent(payload: LegacyEvent) {
    const defaultScope = ensureDefaultScope();
    const defaultScopeId = defaultScope.accessScopeId;
    // The fixtures only ever drive scope-metadata changes (e.g. disabling a
    // scope) and otherwise carry empty entities/changes, so the event upgrade
    // only needs to re-stamp the scope metadata plus any entity deltas it does
    // carry. Translate the carried entities into a v3 scope delta with full
    // upsert rows (the wire always ships complete rows for upserts).
    const split = splitEntities(payload.entities, payload.scope, defaultScopeId);
    const scopeChanges: Array<Record<string, unknown>> = [];
    for (const change of payload.changes) {
      const translated = translateChange(change);
      if (translated) scopeChanges.push(translated);
    }
    // A scope-metadata upsert is implicit when the scope row ships.
    const scopeMetaChanged = payload.changes.length === 0;
    return {
      type: payload.type,
      schemaVersion: 3,
      eventId: payload.eventId,
      sourceVersion: payload.sourceVersion,
      catalog:
        split.catalogRoles.length || split.permissions.length || split.basRolePermissions.length
          ? {
              changes: [],
              roles: split.catalogRoles,
              permissions: split.permissions,
              rolePermissions: split.basRolePermissions,
            }
          : undefined,
      users: payload.entities.users.length
        ? { changes: [], users: payload.entities.users }
        : undefined,
      scopes: [
        {
          accessScopeId: payload.scope.accessScopeId,
          scope: scopeMetaChanged ? toScopeMetadata(payload.scope) : undefined,
          changes: scopeChanges,
          principals: split.principals,
          principalMemberships: split.principalMemberships,
          roles: split.tenantRoles,
          rolePermissionOverrides: split.overrides,
          roleBindings: split.roleBindings,
          permissionBindings: split.permissionBindings,
        },
      ],
    };
  }

  function ensureDefaultScope(): LegacyScope {
    const existing = [...scopeStates.values()].find((entry) => entry.scope.kind === "default");
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
    scopeStates.set(scope.accessScopeId, { scope, entities: emptyEntities() });
    return scope;
  }

  // Aggregate every scope's catalog-eligible rows (reusable roles, all
  // permissions, base role-permissions) into the single deployment-wide catalog.
  function buildCatalogAndUsers(defaultScopeId: string) {
    const rolesById = new Map<string, Record<string, unknown>>();
    const permissionsById = new Map<string, Record<string, unknown>>();
    const rolePermissions: Array<Record<string, unknown>> = [];
    const usersById = new Map<string, Record<string, unknown>>();

    for (const { entities } of scopeStates.values()) {
      for (const user of entities.users) {
        usersById.set(String(user.herculesAuthUserId), normalizeUser(user));
      }
      for (const role of entities.roles) {
        if (!isCatalogRole(role, defaultScopeId)) continue;
        rolesById.set(role.roleId, {
          roleId: role.roleId,
          key: role.key,
          source: catalogRoleSource(role),
          name: role.name ?? role.key,
          baseWildcard: baseWildcardFor(role),
          updatedAt: role.updatedAt,
        });
      }
      for (const permission of entities.permissions) {
        permissionsById.set(permission.permissionId, {
          permissionId: permission.permissionId,
          key: permission.key,
          resourceType: permission.resourceType,
          action: permission.action,
          classification: permission.classification ?? "delegable",
          tenantAssignable: permission.tenantAssignable ?? true,
          updatedAt: permission.updatedAt,
        });
      }
      for (const rp of entities.rolePermissions) {
        // Base role-permission rows are those scoped to the default scope (or
        // unscoped). Per-org rows become overrides in buildScopes.
        if (rp.accessScopeId !== undefined && rp.accessScopeId !== defaultScopeId) continue;
        rolePermissions.push({
          roleId: rp.roleId,
          permissionId: rp.permissionId,
          effect: rp.effect,
          updatedAt: rp.updatedAt,
        });
      }
    }

    return {
      catalog: {
        roles: [...rolesById.values()],
        permissions: [...permissionsById.values()],
        rolePermissions,
      },
      users: [...usersById.values()],
    };
  }

  function buildScopes(defaultScopeId: string) {
    const scopes: Array<Record<string, unknown>> = [];
    for (const { scope, entities } of scopeStates.values()) {
      const split = splitEntities(entities, scope, defaultScopeId);
      scopes.push({
        scope: toScopeMetadata(scope),
        principals: split.principals,
        principalMemberships: split.principalMemberships,
        roles: split.tenantRoles,
        rolePermissionOverrides: split.overrides,
        roleBindings: split.roleBindings,
        permissionBindings: split.permissionBindings,
      });
    }
    return scopes.sort((left, right) => {
      if ((left.scope as LegacyScope).kind === "default") return -1;
      if ((right.scope as LegacyScope).kind === "default") return 1;
      return (left.scope as LegacyScope).accessScopeId.localeCompare(
        (right.scope as LegacyScope).accessScopeId,
      );
    });
  }

  // Split one scope's old `entities` blob into the v3 per-scope arrays plus the
  // catalog-eligible rows it contributes (used by upgradeEvent).
  function splitEntities(entities: LegacyEntities, scope: LegacyScope, defaultScopeId: string) {
    const tenantRoles: Array<Record<string, unknown>> = [];
    const catalogRoles: Array<Record<string, unknown>> = [];
    for (const role of entities.roles) {
      if (isCatalogRole(role, defaultScopeId)) {
        catalogRoles.push({
          roleId: role.roleId,
          key: role.key,
          source: catalogRoleSource(role),
          name: role.name ?? role.key,
          baseWildcard: baseWildcardFor(role),
          updatedAt: role.updatedAt,
        });
        continue;
      }
      tenantRoles.push({
        roleId: role.roleId,
        accessScopeId: scope.accessScopeId,
        key: role.key,
        source: "tenant",
        name: role.name ?? role.key,
        baseWildcard: "none",
        updatedAt: role.updatedAt,
      });
    }

    const overrides: Array<Record<string, unknown>> = [];
    const basRolePermissions: Array<Record<string, unknown>> = [];
    for (const rp of entities.rolePermissions) {
      if (rp.accessScopeId !== undefined && rp.accessScopeId !== defaultScopeId) {
        overrides.push({
          accessScopeId: rp.accessScopeId,
          roleId: rp.roleId,
          permissionId: rp.permissionId,
          effect: rp.effect,
          updatedAt: rp.updatedAt,
        });
      } else {
        basRolePermissions.push({
          roleId: rp.roleId,
          permissionId: rp.permissionId,
          effect: rp.effect,
          updatedAt: rp.updatedAt,
        });
      }
    }

    const roleBindings: Array<Record<string, unknown>> = [];
    const permissionBindings: Array<Record<string, unknown>> = [];
    for (const grant of entities.grants) {
      const resourceType = grant.objectType === "resource" ? grant.objectResourceType : undefined;
      // The old wire used objectId "*" to mean "every instance of the type"
      // (the inherited/parent-level grant). v3 expresses that as a type-wide
      // target: resourceType set, resourceId undefined.
      const resourceId =
        grant.objectType === "resource" && grant.objectId !== "*" ? grant.objectId : undefined;
      if (grant.relationKind === "role") {
        roleBindings.push(
          stripUndefined({
            bindingId: grant.grantId,
            subjectPrincipalId: grant.subjectPrincipalId,
            roleId: grant.roleId,
            accessScopeId: scope.accessScopeId,
            resourceType,
            resourceId,
            appliesTo: grant.appliesTo ?? "self",
            expiresAt: grant.expiresAt,
            updatedAt: grant.updatedAt,
          }),
        );
      } else {
        permissionBindings.push(
          stripUndefined({
            bindingId: grant.grantId,
            subjectPrincipalId: grant.subjectPrincipalId,
            subjectRoleId: grant.subjectRoleId,
            permissionId: grant.permissionId,
            effect: grant.effect ?? "allow",
            accessScopeId: scope.accessScopeId,
            resourceType,
            resourceId,
            appliesTo: grant.appliesTo ?? "self",
            expiresAt: grant.expiresAt,
            updatedAt: grant.updatedAt,
          }),
        );
      }
    }

    return {
      principals: entities.principals.map((row) => stripScopeId(row)),
      principalMemberships: entities.principalMemberships.map((row) => stripScopeId(row)),
      tenantRoles,
      catalogRoles,
      overrides,
      basRolePermissions,
      permissions: entities.permissions.map((permission) => ({
        permissionId: permission.permissionId,
        key: permission.key,
        resourceType: permission.resourceType,
        action: permission.action,
        classification: permission.classification ?? "delegable",
        tenantAssignable: permission.tenantAssignable ?? true,
        updatedAt: permission.updatedAt,
      })),
      roleBindings,
      permissionBindings,
    };
  }
}

function toScopeMetadata(scope: LegacyScope) {
  return {
    accessScopeId: scope.accessScopeId,
    name: scope.name,
    kind: scope.kind,
    status: scope.status,
    accountEntryMode: scope.accountEntryMode,
    defaultRoleId: scope.defaultRoleId,
    updatedAt: scope.updatedAt,
  };
}

function normalizeUser(user: Record<string, unknown>) {
  return {
    herculesAuthUserId: String(user.herculesAuthUserId),
    name: String(user.name ?? ""),
    email: String(user.email ?? "unknown@example.com"),
    emailVerified: Boolean(user.emailVerified ?? false),
    ...(user.image !== undefined ? { image: String(user.image) } : {}),
    ...(user.phone !== undefined ? { phone: String(user.phone) } : {}),
    phoneVerified: Boolean(user.phoneVerified ?? false),
    updatedAt: Number(user.updatedAt ?? 0),
  };
}

// Old principal/membership rows carried accessScopeId inline; the v3 wire keys
// scope membership by the enclosing scope, so drop the redundant column.
function stripScopeId(row: Record<string, unknown>): Record<string, unknown> {
  const { accessScopeId: _drop, ...rest } = row;
  void _drop;
  return rest;
}

function stripUndefined(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Translate a legacy change descriptor into a v3 scope change identity. The
// fixtures rarely drive these (most events carry empty changes), so only the
// shapes the fixtures actually use are mapped.
function translateChange(change: Record<string, unknown>): Record<string, unknown> | null {
  const entityType = String(change.entityType);
  const operation = String(change.operation ?? "upsert");
  switch (entityType) {
    case "principal":
      return { entityType, principalId: String(change.entityId), operation };
    case "grant": {
      // A legacy grant change maps to a role_binding or permission_binding
      // change; without the row we cannot tell which, so default to the
      // binding kind carried on the change when present.
      const kind =
        change.relationKind === "direct_permission" ? "permission_binding" : "role_binding";
      return { entityType: kind, bindingId: String(change.entityId), operation };
    }
    default:
      return null;
  }
}

function isLegacyPayload(payload: unknown): payload is LegacySnapshot | LegacyEvent {
  return (
    payload !== null &&
    typeof payload === "object" &&
    ((payload as { type?: string }).type === "access.projection.snapshot" ||
      (payload as { type?: string }).type === "access.projection.event") &&
    "scope" in payload
  );
}
