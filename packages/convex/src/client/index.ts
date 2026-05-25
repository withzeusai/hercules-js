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
  // DL16 resource grant fallback. Optional; when present, authorize also
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
  roleId?: string;
  roleKey: string;
  roleName: string;
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
  permissions: string[];
};

export type AccessContext =
  | GenericQueryCtx<GenericDataModel>
  | GenericMutationCtx<GenericDataModel>
  | GenericActionCtx<GenericDataModel>;

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

// extractScope can return either a bare scope id (the common case) or a
// richer object that also names a specific resource for DL16 resource
// grant fallback. scopeFromResource returns the richer shape so the
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
    extractScope: ExtractScope<GenericQueryCtx<DataModel>, OneOrZeroArgs[0]>;
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
    extractScope: ExtractScope<GenericMutationCtx<DataModel>, OneOrZeroArgs[0]>;
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
    extractScope: ExtractScope<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
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
  hasPermission: (
    ctx: AccessContext,
    args: { scopeId: string; permission: string; resource?: AccessResourceRef },
  ) => Promise<boolean>;
  requirePermission: (
    ctx: AccessContext,
    args: { scopeId: string; permission: string; resource?: AccessResourceRef },
  ) => Promise<void>;
  requireAnyPermission: (
    ctx: AccessContext,
    args: { scopeId: string; permissions: string[]; resource?: AccessResourceRef },
  ) => Promise<void>;
  getEffectivePermissions: (
    ctx: AccessContext,
    args: { scopeId: string; resource?: AccessResourceRef },
  ) => Promise<string[]>;
  listMyMemberships: (ctx: AccessContext) => Promise<Membership[]>;
  listMyRoles: (ctx: AccessContext, args: { scopeId: string }) => Promise<RoleSummary[]>;
};

type ConvexDefinitionObject<Ctx> = {
  args?: GenericValidator | PropertyValidators | void;
  returns?: GenericValidator | PropertyValidators | void;
  handler: (ctx: Ctx, ...args: never[]) => unknown;
};

type BuilderCaller = (definition: unknown) => unknown;

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
    listMyMemberships: makeListMyMemberships(component),
    listMyRoles: makeListMyRoles(component),
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

// scopeFromResource(tableName, argKey, options?) per DL5.8.
//
// - tableName: the resource's table (used for resource-level grant lookup
//   under DL16; also appears in error messages).
// - argKey: the field on `args` that holds the row id.
// - options.scopeField: the column on the row that carries the org scope
//   id. Defaults to "orgScopeId" per the agent guide convention.
//
// Returns { scopeId, resourceType, resourceId } so the access* builder
// can pass the resource id to authorize, enabling DL16 resource-level
// grants on top of the scope-level check.
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

  const componentName = options.componentName ?? "accessControl";
  const namedComponent = options.components?.[componentName];
  const defaultComponent = options.components?.hercules_access_control;
  const component = namedComponent ?? defaultComponent;

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
      extractScope?: unknown;
    };
    if (
      typeof accessDefinition.permission !== "string" ||
      accessDefinition.permission.length === 0
    ) {
      throw new Error("access* builders require a non-empty permission.");
    }
    if (typeof accessDefinition.extractScope !== "function") {
      throw new Error("access* builders require an extractScope function.");
    }

    const { permission, extractScope, ...convexDefinition } = accessDefinition;
    return (builder as BuilderCaller)(
      wrapDefinition(convexDefinition, component, "permission", {
        permission,
        extractScope: extractScope as ExtractScope<AuthorizationCtx, unknown>,
      }),
    );
  }) as TBuilder;
}

type AccessConfig = { permission?: string; extractScope?: ExtractScope<AuthorizationCtx, unknown> };

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
  return {
    resourceType: resource?.type,
    resourceId: resource?.id,
  };
}

async function getTokenIdentifier(ctx: AccessContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier;
}

function makeHasPermission(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: { scopeId: string; permission: string; resource?: AccessResourceRef },
  ): Promise<boolean> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return false;

    const decision = await ctx.runQuery(component.checks.authorize, {
      tokenIdentifier,
      scopeId: args.scopeId,
      permission: args.permission,
      ...resourceArgs(args.resource),
    });
    return decision.allowed;
  };
}

function makeRequirePermission(component: AccessControlComponent) {
  const hasPermission = makeHasPermission(component);
  return async (
    ctx: AccessContext,
    args: { scopeId: string; permission: string; resource?: AccessResourceRef },
  ): Promise<void> => {
    if (await hasPermission(ctx, args)) return;
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeRequireAnyPermission(component: AccessControlComponent) {
  const hasPermission = makeHasPermission(component);
  return async (
    ctx: AccessContext,
    args: { scopeId: string; permissions: string[]; resource?: AccessResourceRef },
  ): Promise<void> => {
    for (const permission of args.permissions) {
      if (await hasPermission(ctx, { ...args, permission })) return;
    }
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeGetEffectivePermissions(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: { scopeId: string; resource?: AccessResourceRef },
  ): Promise<string[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    const result = await ctx.runQuery(component.queries.getEffectivePermissions, {
      tokenIdentifier,
      scopeId: args.scopeId,
      ...resourceArgs(args.resource),
    });
    return result.permissions;
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
  return async (ctx: AccessContext, args: { scopeId: string }): Promise<RoleSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listMyRoles, {
      tokenIdentifier,
      scopeId: args.scopeId,
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

  // MED-01: short-circuit on missing identity before extractScope so that
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
  if (mode === "permission" && access?.extractScope) {
    try {
      const extracted = await access.extractScope(ctx, callerArgs);
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
        message: "extractScope failed",
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
