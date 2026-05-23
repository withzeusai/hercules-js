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
};

type ListMyMembershipsArgs = { tokenIdentifier?: string };

export type Membership = {
  scopeId: string;
  scopeName: string;
  kind: ScopeKind;
  roleKey: string;
  roleName: string;
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval";
};

export type AccessControlComponent = {
  checks: {
    authorize: FunctionReference<"query", "internal", AuthorizationArgs, AuthorizationDecision>;
  };
  queries: {
    listMyMemberships: FunctionReference<"query", "internal", ListMyMembershipsArgs, Membership[]>;
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

export type ExtractScope<Ctx, Args> = (ctx: Ctx, args: Args) => string | Promise<string>;

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
  };
}

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

export function scopeFromResource<K extends string>(argKey: K, scopeField = "accessScopeId") {
  return async (ctx: DbResourceCtx, args: Record<string, unknown>): Promise<string> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromResource("${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `scopeFromResource("${argKey}"): resource not found`,
      });
    }
    const scopeId = (row as Record<string, unknown>)[scopeField];
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw new ConvexError({
        code: "INVALID_RESOURCE_SCOPE",
        message: `scopeFromResource("${argKey}"): resource is missing "${scopeField}"`,
      });
    }
    return scopeId;
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

async function ensureAuthorized(
  ctx: AuthorizationCtx,
  component: AccessControlComponent,
  mode: AccessMode,
  access: AccessConfig | undefined,
  callerArgs: unknown,
) {
  const identity = await ctx.auth.getUserIdentity();

  let scopeId: string | undefined;
  if (mode === "permission" && access?.extractScope) {
    try {
      scopeId = await access.extractScope(ctx, callerArgs);
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
    tokenIdentifier: identity?.tokenIdentifier,
    scopeId,
    permission: mode === "permission" ? access?.permission : undefined,
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
