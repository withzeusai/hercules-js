// Test-only compiler for the large authorization and query fixture suites.
// Fixtures use compact per-tenant semantic state; this helper materializes that
// state into the current v4 projection wire shape before calling applySync.
//
// The shorthand keeps deployment catalog rows and tenant runtime rows together
// while authoring a scenario. Materialization lifts reusable roles, permissions,
// role-permission mappings, and users to the top level; keeps tenant rows inside
// their scope; and expands grant declarations into role or permission bindings.
//
// This helper never ships in the package. Assertions still exercise the real
// applySync -> schema -> effective -> authorize pipeline.

type FixtureRole = {
  roleId: string;
  accessScopeId?: string;
  key: string;
  kind: string;
  source?: string;
  name?: string;
  description?: string | null;
  wildcard?: "none" | "immutable" | "default";
  updatedAt: number;
};

type FixturePermission = {
  permissionId: string;
  accessScopeId?: string;
  key: string;
  resourceType: string;
  action: string;
  classification?: "delegable" | "owner_only";
  tenantAssignable?: boolean;
  updatedAt: number;
};

type FixtureRolePermission = {
  roleId: string;
  permissionId: string;
  accessScopeId?: string;
  effect: "allow" | "deny";
  updatedAt: number;
};

type FixtureGrant = {
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

type FixtureState = {
  users: Array<Record<string, unknown>>;
  principals: Array<Record<string, unknown>>;
  principalMemberships: Array<Record<string, unknown>>;
  roles: FixtureRole[];
  permissions: FixturePermission[];
  rolePermissions: FixtureRolePermission[];
  grants: FixtureGrant[];
};

type FixtureEventChange =
  | {
      entityType: "principal";
      entityId: string;
      operation: "upsert" | "delete";
    }
  | {
      entityType: "grant";
      entityId: string;
      relationKind: "role" | "direct_permission";
      operation: "upsert" | "delete";
    };

type FixtureScope = {
  accessScopeId: string;
  name: string;
  kind: "default" | "org" | "suite";
  status: "active" | "disabled";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

export type ProjectionFixtureSnapshot = {
  type: "access.projection.snapshot";
  eventId: string;
  sourceVersion: number;
  expectedIssuer: string;
  scope: FixtureScope;
  state: FixtureState;
};

export type ProjectionFixtureEvent = {
  type: "access.projection.event";
  eventId: string;
  sourceVersion: number;
  scope: FixtureScope;
  changes: FixtureEventChange[];
  state: FixtureState;
};

export type ProjectionFixturePayload = ProjectionFixtureSnapshot | ProjectionFixtureEvent;

const emptyState = (): FixtureState => ({
  users: [],
  principals: [],
  principalMemberships: [],
  roles: [],
  permissions: [],
  rolePermissions: [],
  grants: [],
});

// `kind` classifies reusable catalog roles versus tenant-owned roles. It stays
// authoritative when a tenant role is attached to the default scope.
function isCatalogRole(role: FixtureRole, _defaultScopeId: string): boolean {
  void _defaultScopeId;
  if (role.kind === "system" || role.kind === "default" || role.kind === "iam") return true;
  if (role.source === "iam" || role.source === "system") return true;
  return false;
}

function catalogRoleSource(role: FixtureRole): "system" | "iam" {
  return role.source === "iam" ? "iam" : "system";
}

function baseWildcardFor(role: FixtureRole): "none" | "immutable" | "default" {
  if (role.wildcard === "immutable") return "immutable";
  if (role.wildcard === "default") return "default";
  return "none";
}

// The wrapped TestConvex additionally accepts compact projection fixtures as a
// mutation payload. Non-fixture payloads pass through unchanged.
export type WithProjectionFixtures<T extends { mutation: (...args: never[]) => unknown }> = Omit<
  T,
  "mutation"
> & {
  mutation: T["mutation"] &
    ((reference: never, payload: ProjectionFixturePayload) => Promise<unknown>);
};

/**
 * Materializes compact semantic fixtures into the current projection protocol.
 */
export function withProjectionFixtures<T extends { mutation: (...args: never[]) => unknown }>(
  target: T,
): WithProjectionFixtures<T> {
  // Accumulate the latest state for every fixture scope so sequential snapshots
  // materialize into one complete deployment snapshot.
  const scopeStates = new Map<string, { scope: FixtureScope; state: FixtureState }>();
  let initialized = false;
  const mutation = target.mutation.bind(target);

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== "mutation") return Reflect.get(object, property, receiver);
      return async (reference: unknown, payload: unknown) => {
        const materialized = materializePayload(payload);
        const result = await (mutation as (...args: unknown[]) => Promise<unknown>)(
          reference,
          materialized,
        );
        if (
          materialized &&
          typeof materialized === "object" &&
          (materialized as { type?: string }).type === "access.projection.snapshot" &&
          (result as { ok?: boolean }).ok
        ) {
          initialized = true;
        }
        return result;
      };
    },
  }) as unknown as WithProjectionFixtures<T>;

  function materializePayload(payload: unknown): unknown {
    if (!isProjectionFixturePayload(payload)) return payload;
    if (payload.type === "access.projection.event") return materializeEvent(payload);
    return materializeSnapshot(payload);
  }

  function materializeSnapshot(payload: ProjectionFixtureSnapshot) {
    scopeStates.set(payload.scope.accessScopeId, {
      scope: payload.scope,
      state: payload.state,
    });
    const defaultScope = ensureDefaultScope();
    const { catalog, users } = buildCatalogAndUsers(defaultScope.accessScopeId);
    return {
      type: payload.type,
      schemaVersion: 4,
      eventId: payload.eventId,
      mode: initialized ? "reset" : "initialize",
      sourceVersion: payload.sourceVersion,
      expectedIssuer: payload.expectedIssuer,
      catalog,
      users,
      scopes: buildScopes(defaultScope.accessScopeId),
    };
  }

  function materializeEvent(payload: ProjectionFixtureEvent) {
    const defaultScope = ensureDefaultScope();
    const defaultScopeId = defaultScope.accessScopeId;
    // Materialize the compact state as a v4 scope delta with complete rows for
    // every upsert.
    const split = splitState(payload.state, payload.scope, defaultScopeId);
    if (
      payload.state.users.length > 0 ||
      split.catalogRoles.length > 0 ||
      split.permissions.length > 0 ||
      split.basRolePermissions.length > 0 ||
      split.principalMemberships.length > 0 ||
      split.tenantRoles.length > 0 ||
      split.overrides.length > 0
    ) {
      throw new Error(
        "Projection fixture events only support scope metadata, principals, and grants. Author other event deltas directly in the v4 wire shape.",
      );
    }
    const scopeChanges = payload.changes.map(translateChange);
    // A scope-metadata upsert is implicit when the scope row ships.
    const scopeMetaChanged = payload.changes.length === 0;
    return {
      type: payload.type,
      schemaVersion: 4,
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
      users: payload.state.users.length ? { changes: [], users: payload.state.users } : undefined,
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

  function ensureDefaultScope(): FixtureScope {
    const existing = [...scopeStates.values()].find((entry) => entry.scope.kind === "default");
    if (existing) return existing.scope;
    const scope: FixtureScope = {
      accessScopeId: "scope_default",
      name: "Default",
      kind: "default",
      status: "active",
      accessMode: "open",
      defaultRoleId: "role_member",
      updatedAt: 0,
    };
    scopeStates.set(scope.accessScopeId, { scope, state: emptyState() });
    return scope;
  }

  // Aggregate every scope's catalog-eligible rows (reusable roles, all
  // permissions, base role-permissions) into the single deployment-wide catalog.
  function buildCatalogAndUsers(defaultScopeId: string) {
    const rolesById = new Map<string, Record<string, unknown>>();
    const permissionsById = new Map<string, Record<string, unknown>>();
    const rolePermissions: Array<Record<string, unknown>> = [];
    const usersById = new Map<string, Record<string, unknown>>();

    for (const { state } of scopeStates.values()) {
      for (const user of state.users) {
        usersById.set(String(user.herculesAuthUserId), normalizeUser(user));
      }
      for (const role of state.roles) {
        if (!isCatalogRole(role, defaultScopeId)) continue;
        rolesById.set(role.roleId, {
          roleId: role.roleId,
          key: role.key,
          source: catalogRoleSource(role),
          name: role.name ?? role.key,
          description: role.description ?? null,
          baseWildcard: baseWildcardFor(role),
          updatedAt: role.updatedAt,
        });
      }
      for (const permission of state.permissions) {
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
      for (const rp of state.rolePermissions) {
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
    for (const { scope, state } of scopeStates.values()) {
      const split = splitState(state, scope, defaultScopeId);
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
      if ((left.scope as FixtureScope).kind === "default") return -1;
      if ((right.scope as FixtureScope).kind === "default") return 1;
      return (left.scope as FixtureScope).accessScopeId.localeCompare(
        (right.scope as FixtureScope).accessScopeId,
      );
    });
  }

  // Split compact fixture state into current per-scope arrays and catalog rows.
  function splitState(state: FixtureState, scope: FixtureScope, defaultScopeId: string) {
    const tenantRoles: Array<Record<string, unknown>> = [];
    const catalogRoles: Array<Record<string, unknown>> = [];
    for (const role of state.roles) {
      if (isCatalogRole(role, defaultScopeId)) {
        catalogRoles.push({
          roleId: role.roleId,
          key: role.key,
          source: catalogRoleSource(role),
          name: role.name ?? role.key,
          description: role.description ?? null,
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
        description: role.description ?? null,
        baseWildcard: "none",
        updatedAt: role.updatedAt,
      });
    }

    const overrides: Array<Record<string, unknown>> = [];
    const basRolePermissions: Array<Record<string, unknown>> = [];
    for (const rp of state.rolePermissions) {
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
    for (const grant of state.grants) {
      const resourceType = grant.objectType === "resource" ? grant.objectResourceType : undefined;
      // Fixture objectId "*" is shorthand for a type-wide resource target.
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
      principals: state.principals.map((row) => stripScopeId(row)),
      principalMemberships: state.principalMemberships.map((row) => stripScopeId(row)),
      tenantRoles,
      catalogRoles,
      overrides,
      basRolePermissions,
      permissions: state.permissions.map((permission) => ({
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

function toScopeMetadata(scope: FixtureScope) {
  return {
    accessScopeId: scope.accessScopeId,
    name: scope.name,
    kind: scope.kind,
    status: scope.status,
    accessMode: scope.accessMode,
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

// Fixture principal rows may carry accessScopeId for readability; the current
// wire keys scope membership by the enclosing scope.
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

// Translate the compact change descriptors used by these fixtures into current
// scope change identities.
function translateChange(change: FixtureEventChange): Record<string, unknown> {
  switch (change.entityType) {
    case "principal":
      return {
        entityType: change.entityType,
        principalId: change.entityId,
        operation: change.operation,
      };
    case "grant": {
      // A grant change maps to the binding kind declared on the fixture change.
      const kind =
        change.relationKind === "direct_permission" ? "permission_binding" : "role_binding";
      return {
        entityType: kind,
        bindingId: change.entityId,
        operation: change.operation,
      };
    }
  }
}

function isProjectionFixturePayload(
  payload: unknown,
): payload is ProjectionFixtureSnapshot | ProjectionFixtureEvent {
  return (
    payload !== null &&
    typeof payload === "object" &&
    ((payload as { type?: string }).type === "access.projection.snapshot" ||
      (payload as { type?: string }).type === "access.projection.event") &&
    "scope" in payload
  );
}
