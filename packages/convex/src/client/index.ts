import type {
  ActionBuilder,
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
} from "convex/server";
import { ConvexError } from "convex/values";
import type { GenericValidator, PropertyValidators, Validator } from "convex/values";
import type { ScopeKind } from "../shared/sync";

type AccessMode = "authenticated" | "permission";

type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
};

type AuthorizationArgs = {
  tokenIdentifier?: string;
  scopeId?: string;
  permission?: string;
  // DL16 resource grant support. Optional; when present, authorize also
  // walks grants whose object is the specific resource.
  resourceType?: string;
  resourceId?: string;
};

type ListMyMembershipsArgs = { tokenIdentifier?: string };
type ListMyRolesArgs = { tokenIdentifier?: string; scopeId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType?: string;
  resourceId?: string;
};

type ListScopeArgs = { tokenIdentifier?: string; scopeId: string };

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

export type Membership = {
  scopeId: string;
  scopeName: string;
  kind: ScopeKind;
  roles: RoleSummary[];
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval";
};

export type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  scopeId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  // §0b: the principal's resolved wildcard mode. Under the wildcard model
  // `permissions` is a projection over the unbounded catalog (Owner = whole
  // catalog, Admin = catalog minus Owner-only levers), so callers should treat
  // a non-"none" mode as future-inclusive rather than exhaustive.
  wildcard: "none" | "immutable" | "default";
  permissions: string[];
};

export type ScopeMember = {
  principalId: string;
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
};

export type ScopeRoleSummary = RoleSummary & { shared: boolean };

export type ScopePermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  tenantAssignable: boolean;
};

export type AccessContext<DataModel extends GenericDataModel = any> =
  | Pick<GenericQueryCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery">;

export type AccessResourceRef = { type: string; id: string };

export type AccessControlComponent = {
  checks: {
    authorize: FunctionReference<"query", "internal", AuthorizationArgs, AuthorizationDecision>;
  };
  queries: {
    listMyMemberships: FunctionReference<"query", "internal", ListMyMembershipsArgs, Membership[]>;
    listMyRoles: FunctionReference<"query", "internal", ListMyRolesArgs, RoleSummary[]>;
    getEffectivePermissions: FunctionReference<
      "query",
      "internal",
      GetEffectivePermissionsArgs,
      EffectivePermissionsResult
    >;
    listScopeMembers: FunctionReference<"query", "internal", ListScopeArgs, ScopeMember[]>;
    listScopeRoles: FunctionReference<"query", "internal", ListScopeArgs, ScopeRoleSummary[]>;
    listScopePermissions: FunctionReference<
      "query",
      "internal",
      ListScopeArgs,
      ScopePermissionSummary[]
    >;
  };
};

export type CreateAccessControlOptions<DataModel extends GenericDataModel> = {
  query: QueryBuilder<DataModel, "public">;
  mutation: MutationBuilder<DataModel, "public">;
  action: ActionBuilder<DataModel, "public">;
  components?: Record<string, unknown>;
  component?: AccessControlComponent;
  componentName?: string;
};

// A scope extractor can return either a bare scope id (the common case) or a
// richer object that also names a specific resource for DL16 resource
// grant support. scopeFromResource returns the richer shape so the
// authorize call can walk resource-object grants.
export type ExtractedScope =
  | string
  | { scopeId: string; resourceType?: string; resourceId?: string };

export type ExtractScope<Ctx, Args> = (
  ctx: Ctx,
  args: Args,
) => ExtractedScope | Promise<ExtractedScope>;

export type AccessQueryBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(query: {
    permission: string;
    scope?: ExtractScope<GenericQueryCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredQuery<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type AccessMutationBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(mutation: {
    permission: string;
    scope?: ExtractScope<GenericMutationCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredMutation<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type AccessActionBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(action: {
    permission: string;
    scope?: ExtractScope<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredAction<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type AccessControlBuilders<DataModel extends GenericDataModel> = {
  publicQuery: QueryBuilder<DataModel, "public">;
  publicMutation: MutationBuilder<DataModel, "public">;
  publicAction: ActionBuilder<DataModel, "public">;
  authenticatedQuery: QueryBuilder<DataModel, "public">;
  authenticatedMutation: MutationBuilder<DataModel, "public">;
  authenticatedAction: ActionBuilder<DataModel, "public">;
  accessQuery: AccessQueryBuilder<DataModel>;
  accessMutation: AccessMutationBuilder<DataModel>;
  accessAction: AccessActionBuilder<DataModel>;
  hasPermission: (ctx: AccessContext<DataModel>, args: PermissionCheckArgs) => Promise<boolean>;
  requirePermission: (ctx: AccessContext<DataModel>, args: PermissionCheckArgs) => Promise<void>;
  requireAnyPermission: (
    ctx: AccessContext<DataModel>,
    args: AnyPermissionCheckArgs,
  ) => Promise<void>;
  getEffectivePermissions: (
    ctx: AccessContext<DataModel>,
    args?: EffectivePermissionsArgs,
  ) => Promise<string[]>;
  // Filter a page of the APP's own resource rows down to the ones the caller is
  // allowed to access, by running the same per-resource permission check as a
  // real `accessQuery`. Use this for "list my projects" style lists: the app
  // owns and paginates its rows, Hercules never enumerates them. Pass a bounded
  // page, not an entire table (it runs one check per item).
  filterAuthorizedResources: <T>(
    ctx: AccessContext<DataModel>,
    args: {
      resources: T[];
      permission: string;
      scopeId?: string;
      resource: (item: T) => AccessResourceRef;
    },
  ) => Promise<T[]>;
  listMyMemberships: (ctx: AccessContext<DataModel>) => Promise<Membership[]>;
  listMyRoles: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<RoleSummary[]>;
  // Scope-admin reads for an in-app management screen. Each requires the caller
  // to hold the matching read permission (system.members:read / system.roles:read
  // / system.permissions:read) in the scope; otherwise they resolve to an empty
  // list. Reads come from the local mirror, like every other access query.
  listScopeMembers: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<ScopeMember[]>;
  listScopeRoles: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<ScopeRoleSummary[]>;
  listScopePermissions: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<ScopePermissionSummary[]>;
};

export type PermissionCheckArgs =
  | string
  | { scopeId?: string; permission: string; resource?: AccessResourceRef };

export type AnyPermissionCheckArgs =
  | string[]
  | { scopeId?: string; permissions: string[]; resource?: AccessResourceRef };

export type EffectivePermissionsArgs = { scopeId?: string; resource?: AccessResourceRef };

type ConvexDefinitionObject<Ctx> = {
  args?: GenericValidator | PropertyValidators | void;
  returns?: GenericValidator | PropertyValidators | void;
  handler: (ctx: Ctx, ...args: never[]) => unknown;
};

type BuilderCaller = (definition: unknown) => unknown;

/**
 * Wires Hercules managed Access Control into a Convex app. Call once in
 * `convex/hercules.ts`, passing the generated `query`/`mutation`/`action`
 * builders and `components`, then re-export the returned builders.
 *
 * Returned builders:
 * - `publicQuery`/`publicMutation`/`publicAction`: no auth.
 * - `authenticatedQuery`/`...Mutation`/`...Action`: require sign-in only.
 * - `accessQuery`/`accessMutation`/`accessAction`: enforce a permission in a
 *   scope. Pass `{ permission, scope }`; resolve `scope` with `scopeFromArg`
 *   or `scopeFromResource`. Use these for all org-owned reads and writes.
 * - `hasPermission`/`requirePermission`/`requireAnyPermission`/
 *   `getEffectivePermissions`: in-handler checks. `getEffectivePermissions`
 *   and `hasPermission` accept an optional `{ resource }` ref for per-resource
 *   (e.g. per-project) checks.
 * - `listMyMemberships`/`listMyRoles`: the caller's own scopes/roles.
 * - `listScopeMembers`/`listScopeRoles`/`listScopePermissions`: admin reads
 *   for an in-app management screen. Each self-gates on the matching
 *   `system.*:read` permission and returns `[]` when the caller lacks it.
 *
 * Reads resolve against the app's local Access Control mirror, which lags the
 * control plane by a short projection-sync window after any change.
 */
export function createAccessControl<DataModel extends GenericDataModel>(
  options: CreateAccessControlOptions<DataModel>,
): AccessControlBuilders<DataModel> {
  const component = resolveComponent(options);

  return {
    publicQuery: options.query,
    publicMutation: options.mutation,
    publicAction: options.action,
    authenticatedQuery: makeAuthenticatedBuilder(options.query, component),
    authenticatedMutation: makeAuthenticatedBuilder(options.mutation, component),
    authenticatedAction: makeAuthenticatedBuilder(options.action, component),
    accessQuery: makeAccessBuilder(options.query, component) as AccessQueryBuilder<DataModel>,
    accessMutation: makeAccessBuilder(
      options.mutation,
      component,
    ) as AccessMutationBuilder<DataModel>,
    accessAction: makeAccessBuilder(options.action, component) as AccessActionBuilder<DataModel>,
    hasPermission: makeHasPermission(component),
    requirePermission: makeRequirePermission(component),
    requireAnyPermission: makeRequireAnyPermission(component),
    getEffectivePermissions: makeGetEffectivePermissions(component),
    filterAuthorizedResources: makeFilterAuthorizedResources(component),
    listMyMemberships: makeListMyMemberships(component),
    listMyRoles: makeListMyRoles(component),
    listScopeMembers: makeListScopeMembers(component),
    listScopeRoles: makeListScopeRoles(component),
    listScopePermissions: makeListScopePermissions(component),
  };
}

// Single-tenant apps that don't pass a scope arg: every check resolves to
// the app's default scope. The component query looks up the default scope
// row from the mirror, so this helper just returns a sentinel string and
// authorize resolves it. The sentinel is treated as "use the default scope"
// inside the authorize implementation (component reads the unique row with
// kind="default").
export const DEFAULT_SCOPE_SENTINEL = "__hercules_default_scope__";

export const defaultScope: ExtractScope<unknown, unknown> = () => DEFAULT_SCOPE_SENTINEL;

/**
 * Resolves the scope for an `access*` builder from a string arg the caller
 * passes (e.g. the active org id). Use for list/create handlers where the
 * frontend already knows the scope. Throws if the arg is missing or empty.
 *
 * Do not use this for an operation that receives an org-owned row id (read,
 * update, delete): a caller could pair their own scope id with another org's
 * row. Use `scopeFromResource` there so the scope is read from the row.
 */
export function scopeFromArg<K extends string>(argKey: K) {
  return (_ctx: unknown, args: Record<string, unknown>): string => {
    const value = args?.[argKey];
    if (typeof value !== "string" || value.length === 0) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromArg("${argKey}"): expected non-empty string on args.${argKey}`,
      });
    }
    return value;
  };
}

type DbResourceCtx = { db: { get(id: unknown): Promise<unknown> } };

/**
 * Resolves the scope from a referenced row for an `access*` builder. Reads
 * the row named by `argKey`, returns `{ scopeId, resourceType, resourceId }`,
 * and lets `authorize` apply resource-level grants on top of the scope check.
 * Use for any read/update/delete that receives an org-owned row id.
 *
 * Params:
 * - `tableName`: the row's table. NOTE: this becomes the `resourceType`.
 * - `argKey`: the field on `args` holding the row id.
 * - `options.scopeField`: column carrying the org scope id (default
 *   `"orgScopeId"`).
 *
 * Gotcha: a resource grant only applies if its `resourceType` matches the
 * `resourceType` returned here. By default that is the table name. If your
 * resource permissions use a different resource type (e.g. `app.project`
 * rather than the `projects` table), resolve the scope so `resourceType`
 * matches the permission's resource type, or the grant will not be found.
 */
export function scopeFromResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: { scopeField?: string } = {},
) {
  const scopeField = options.scopeField ?? "orgScopeId";
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{ scopeId: string; resourceType: string; resourceId: string }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `scopeFromResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const scopeId = (row as Record<string, unknown>)[scopeField];
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw new ConvexError({
        code: "INVALID_RESOURCE_SCOPE",
        message: `scopeFromResource("${tableName}", "${argKey}"): resource is missing "${scopeField}"`,
      });
    }
    return { scopeId, resourceType: tableName, resourceId: String(id) };
  };
}

function resolveComponent<DataModel extends GenericDataModel>(
  options: CreateAccessControlOptions<DataModel>,
): AccessControlComponent {
  if (options.component) {
    return options.component;
  }

  const componentName = options.componentName ?? "hercules";
  const component = options.components?.[componentName];

  if (!component) {
    throw new Error(
      "Missing Hercules Access Control component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component as AccessControlComponent;
}

function makeAuthenticatedBuilder<TBuilder>(
  builder: TBuilder,
  component: AccessControlComponent,
): TBuilder {
  return ((definition: unknown) => {
    return (builder as BuilderCaller)(wrapDefinition(definition, component, "authenticated"));
  }) as TBuilder;
}

function makeAccessBuilder<TBuilder>(
  builder: TBuilder,
  component: AccessControlComponent,
): TBuilder {
  return ((definition: unknown) => {
    if (typeof definition !== "object" || definition === null || !("handler" in definition)) {
      throw new Error("access* builders require an object definition with a permission.");
    }

    const accessDefinition = definition as ConvexDefinitionObject<AuthorizationCtx> & {
      permission?: unknown;
      scope?: unknown;
    };
    if (
      typeof accessDefinition.permission !== "string" ||
      accessDefinition.permission.length === 0
    ) {
      throw new Error("access* builders require a non-empty permission.");
    }
    if (accessDefinition.scope !== undefined && typeof accessDefinition.scope !== "function") {
      throw new Error("access* builders require scope to be a function.");
    }
    const { permission, scope, ...convexDefinition } = accessDefinition;
    const scopeExtractor = (scope ?? defaultScope) as ExtractScope<AuthorizationCtx, unknown>;
    return (builder as BuilderCaller)(
      wrapDefinition(convexDefinition, component, "permission", {
        permission,
        scope: scopeExtractor,
      }),
    );
  }) as TBuilder;
}

type AccessConfig = { permission?: string; scope?: ExtractScope<AuthorizationCtx, unknown> };

function wrapDefinition(
  definition: unknown,
  component: AccessControlComponent,
  mode: AccessMode,
  access?: AccessConfig,
) {
  if (typeof definition === "function") {
    return async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, access, args[0]);
      return (definition as (ctx: AuthorizationCtx, ...rest: never[]) => unknown)(ctx, ...args);
    };
  }

  const objectDefinition = definition as ConvexDefinitionObject<AuthorizationCtx>;
  return {
    ...objectDefinition,
    handler: async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, access, args[0]);
      return objectDefinition.handler(ctx, ...args);
    },
  };
}

type AuthorizationCtx =
  | GenericQueryCtx<GenericDataModel>
  | GenericMutationCtx<GenericDataModel>
  | GenericActionCtx<GenericDataModel>;

function resourceArgs(resource?: AccessResourceRef) {
  return { resourceType: resource?.type, resourceId: resource?.id };
}

async function getTokenIdentifier(ctx: AccessContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? undefined;
}

function normalizePermissionCheckArgs(args: PermissionCheckArgs) {
  if (typeof args === "string") {
    return { scopeId: DEFAULT_SCOPE_SENTINEL, permission: args, resource: undefined };
  }
  return {
    scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    permission: args.permission,
    resource: args.resource,
  };
}

function normalizeAnyPermissionCheckArgs(args: AnyPermissionCheckArgs) {
  if (Array.isArray(args)) {
    return { scopeId: DEFAULT_SCOPE_SENTINEL, permissions: args, resource: undefined };
  }
  return {
    scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    permissions: args.permissions,
    resource: args.resource,
  };
}

function normalizeEffectivePermissionsArgs(args: EffectivePermissionsArgs | undefined) {
  return { scopeId: args?.scopeId ?? DEFAULT_SCOPE_SENTINEL, resource: args?.resource };
}

function makeHasPermission(component: AccessControlComponent) {
  return async (ctx: AccessContext, args: PermissionCheckArgs): Promise<boolean> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return false;
    const normalized = normalizePermissionCheckArgs(args);

    const decision = await ctx.runQuery(component.checks.authorize, {
      tokenIdentifier,
      scopeId: normalized.scopeId,
      permission: normalized.permission,
      ...resourceArgs(normalized.resource),
    });
    return decision.allowed;
  };
}

function makeRequirePermission(component: AccessControlComponent) {
  const hasPermission = makeHasPermission(component);
  return async (ctx: AccessContext, args: PermissionCheckArgs): Promise<void> => {
    if (await hasPermission(ctx, args)) return;
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeRequireAnyPermission(component: AccessControlComponent) {
  const hasPermission = makeHasPermission(component);
  return async (ctx: AccessContext, args: AnyPermissionCheckArgs): Promise<void> => {
    const normalized = normalizeAnyPermissionCheckArgs(args);
    for (const permission of normalized.permissions) {
      if (await hasPermission(ctx, { ...normalized, permission })) return;
    }
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeGetEffectivePermissions(component: AccessControlComponent) {
  return async (ctx: AccessContext, args?: EffectivePermissionsArgs): Promise<string[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];
    const normalized = normalizeEffectivePermissionsArgs(args);

    const result = await ctx.runQuery(component.queries.getEffectivePermissions, {
      tokenIdentifier,
      scopeId: normalized.scopeId,
      ...resourceArgs(normalized.resource),
    });
    return result.permissions;
  };
}

function makeFilterAuthorizedResources(component: AccessControlComponent) {
  return async <T>(
    ctx: AccessContext,
    args: {
      resources: T[];
      permission: string;
      scopeId?: string;
      resource: (item: T) => AccessResourceRef;
    },
  ): Promise<T[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];
    const scopeId = args.scopeId ?? DEFAULT_SCOPE_SENTINEL;

    const allowed: T[] = [];
    for (const item of args.resources) {
      const ref = args.resource(item);
      const decision = await ctx.runQuery(component.checks.authorize, {
        tokenIdentifier,
        scopeId,
        permission: args.permission,
        resourceType: ref.type,
        resourceId: ref.id,
      });
      if (decision.allowed) allowed.push(item);
    }
    return allowed;
  };
}

function makeListMyMemberships(component: AccessControlComponent) {
  return async (ctx: AccessContext): Promise<Membership[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listMyMemberships, { tokenIdentifier });
  };
}

function makeListMyRoles(component: AccessControlComponent) {
  return async (ctx: AccessContext, args: { scopeId?: string } = {}): Promise<RoleSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listMyRoles, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    });
  };
}

function makeListScopeMembers(component: AccessControlComponent) {
  return async (ctx: AccessContext, args: { scopeId?: string } = {}): Promise<ScopeMember[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listScopeMembers, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    });
  };
}

function makeListScopeRoles(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: { scopeId?: string } = {},
  ): Promise<ScopeRoleSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listScopeRoles, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    });
  };
}

function makeListScopePermissions(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: { scopeId?: string } = {},
  ): Promise<ScopePermissionSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listScopePermissions, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    });
  };
}

async function ensureAuthorized(
  ctx: AuthorizationCtx,
  component: AccessControlComponent,
  mode: AccessMode,
  access: AccessConfig | undefined,
  callerArgs: unknown,
) {
  const identity = await ctx.auth.getUserIdentity();

  // MED-01: short-circuit on missing identity before scope extraction so that
  // unauthenticated callers cannot probe resource existence by observing
  // INVALID_SCOPE_ARG vs RESOURCE_NOT_FOUND vs INVALID_RESOURCE_SCOPE.
  if (!identity?.tokenIdentifier) {
    throw new ConvexError({
      code: mode === "permission" ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      message: mode === "permission" ? "Access denied" : "Authentication required",
      reasonCode: "missing_identity",
    });
  }

  let scopeId: string | undefined;
  let resourceType: string | undefined;
  let resourceId: string | undefined;
  if (mode === "permission") {
    try {
      const extracted = await (access?.scope ?? defaultScope)(ctx, callerArgs);
      if (typeof extracted === "string") {
        scopeId = extracted;
      } else {
        scopeId = extracted.scopeId;
        resourceType = extracted.resourceType;
        resourceId = extracted.resourceId;
      }
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "scope extraction failed",
        reasonCode: "scope_extract_failed",
      });
    }
  }

  const decision = await ctx.runQuery(component.checks.authorize, {
    tokenIdentifier: identity.tokenIdentifier,
    scopeId,
    permission: mode === "permission" ? access?.permission : undefined,
    resourceType,
    resourceId,
  });

  if (!decision.allowed) {
    throw new ConvexError({
      code: mode === "permission" ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      message: mode === "permission" ? "Access denied" : "Authentication required",
      reasonCode: decision.reasonCode,
      sourceVersion: decision.sourceVersion,
    });
  }
}
