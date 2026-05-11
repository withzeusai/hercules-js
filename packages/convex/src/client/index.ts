import { ConvexError } from "convex/values";
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
import type { GenericValidator, PropertyValidators, Validator } from "convex/values";
import type { AccessTargetType } from "../shared/sync";

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
  permission?: string;
  targetType?: AccessTargetType;
  targetId?: string;
};

export type AccessControlComponent = {
  checks: {
    authorize: FunctionReference<"query", "public", AuthorizationArgs, AuthorizationDecision>;
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

export type AccessQueryBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
  >(
    query: {
      permission: string;
      targetType?: AccessTargetType;
      targetId?: string;
      args?: ArgsValidator;
      returns?: ReturnsValidator;
      handler: (ctx: GenericQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
    },
  ): RegisteredQuery<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type AccessMutationBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
  >(
    mutation: {
      permission: string;
      targetType?: AccessTargetType;
      targetId?: string;
      args?: ArgsValidator;
      returns?: ReturnsValidator;
      handler: (ctx: GenericMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
    },
  ): RegisteredMutation<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type AccessActionBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
  >(
    action: {
      permission: string;
      targetType?: AccessTargetType;
      targetId?: string;
      args?: ArgsValidator;
      returns?: ReturnsValidator;
      handler: (ctx: GenericActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
    },
  ): RegisteredAction<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
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
    accessMutation: makeAccessBuilder(options.mutation, component) as AccessMutationBuilder<DataModel>,
    accessAction: makeAccessBuilder(options.action, component) as AccessActionBuilder<DataModel>,
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

  if (!isAccessControlComponent(component)) {
    throw new Error(
      "Missing Hercules Access Control component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component;
}

function isAccessControlComponent(component: unknown): component is AccessControlComponent {
  return (
    typeof component === "object" &&
    component !== null &&
    "checks" in component &&
    typeof component.checks === "object" &&
    component.checks !== null &&
    "authorize" in component.checks
  );
}

function makeAuthenticatedBuilder<TBuilder>(
  builder: TBuilder,
  component: AccessControlComponent,
): TBuilder {
  return ((definition: unknown) => {
    return (builder as BuilderCaller)(wrapDefinition(definition, component, "authenticated"));
  }) as TBuilder;
}

function makeAccessBuilder<TBuilder>(builder: TBuilder, component: AccessControlComponent): TBuilder {
  return ((definition: unknown) => {
    if (typeof definition !== "object" || definition === null || !("handler" in definition)) {
      throw new Error("access* builders require an object definition with a permission.");
    }

    const accessDefinition = definition as ConvexDefinitionObject<AuthorizationCtx> & {
      permission?: unknown;
      targetType?: AccessTargetType;
      targetId?: string;
    };
    if (typeof accessDefinition.permission !== "string" || accessDefinition.permission.length === 0) {
      throw new Error("access* builders require a non-empty permission.");
    }

    const { permission, targetType, targetId, ...convexDefinition } = accessDefinition;
    return (builder as BuilderCaller)(
      wrapDefinition(convexDefinition, component, "permission", {
        permission,
        targetType,
        targetId,
      }),
    );
  }) as TBuilder;
}

function wrapDefinition(
  definition: unknown,
  component: AccessControlComponent,
  mode: AccessMode,
  access?: { permission?: string; targetType?: AccessTargetType; targetId?: string },
) {
  if (typeof definition === "function") {
    return async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, access);
      return definition(ctx, ...args);
    };
  }

  const objectDefinition = definition as ConvexDefinitionObject<AuthorizationCtx>;
  return {
    ...objectDefinition,
    handler: async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, access);
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
  access?: { permission?: string; targetType?: AccessTargetType; targetId?: string },
) {
  const identity = await ctx.auth.getUserIdentity();
  const decision = await ctx.runQuery(component.checks.authorize, {
    tokenIdentifier: identity?.tokenIdentifier,
    permission: mode === "permission" ? access?.permission : undefined,
    targetType: access?.targetType,
    targetId: access?.targetId,
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
