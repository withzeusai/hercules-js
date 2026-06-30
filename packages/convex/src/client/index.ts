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
import type { PropertyValidators, Validator } from "convex/values";
export { classifyIamError } from "./iam-errors.js";
export type { IamAdmissionStatus, IamErrorClassification } from "./iam-errors.js";

// ── shared model types (match the component return shapes) ────────────────────
export type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  isSystemRole: boolean;
  isRestricted: boolean;
  // Tenant scope: null = SHARED (usable in every tenant); a tenant id = the
  // OWNING tenant of a tenant-scoped role.
  tenantId: string | null;
};

export type DirectRoleAssignment = RoleSummary & {
  assignmentId: string;
  expiresAt: number | null;
};

export type TenantSummary = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

export type TenantSummariesPage = { tenants: TenantSummary[]; nextCursor?: string };

export type TenantDetail = {
  tenantId: string;
  herculesAuthTenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  lifecycleStatus: "active" | "archived";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

export type TenantDetailsPage = { tenants: TenantDetail[]; nextCursor?: string };

export type TenantUser = {
  userId: string;
  status: MembershipStatus;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

export type TenantGroup = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
  memberCount: number;
  roles: RoleSummary[];
  directRoleAssignments: DirectRoleAssignment[];
};

export type TenantUsersPage = { users: TenantUser[]; nextCursor?: string };
export type TenantGroupsPage = { groups: TenantGroup[]; nextCursor?: string };

export type RoleDetail = RoleSummary & {
  description: string | null;
  permissionKeys: string[];
};

export type ResourceRef = { type: string; externalId: string };

export type ResourceNode = {
  type: string;
  externalId: string;
  parent?: ResourceRef;
  data?: unknown;
};

export type ResourceNodesPage = { resources: ResourceNode[]; nextCursor?: string };

export type IamTenantAccessStatusResult =
  | { kind: "principal"; membershipId: string; status: MembershipStatus; stateVersion: number }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "tenant_missing"
        | "membership_missing";
      stateVersion?: number;
    };

export type TargetTenantSyncStatus =
  | { state: "syncing"; currentSourceVersion?: number; targetSourceVersion: number }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      membershipId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      membershipId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

export type AccessDecision = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  membershipId?: string;
};

// ── component function-reference contract (what this client calls) ────────────
type CheckArgs = {
  tokenIdentifier?: string;
  tenantId?: string;
  permission: string;
  resource?: ResourceRef;
};

type Cursored<T> = T & { cursor?: string };
type ComponentPage<K extends string, V> = { [P in K]: V[] } & { cursor?: string };

export type IamComponent = {
  checks: {
    check: FunctionReference<"query", "public", CheckArgs, AccessDecision>;
    checkMany: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; checks: Omit<CheckArgs, "tokenIdentifier">[] },
      AccessDecision[]
    >;
  };
  queries: {
    getTenantAccessStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      IamTenantAccessStatusResult
    >;
    listMyTenants: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; cursor?: string; limit?: number; status?: "active" | "all" },
      ComponentPage<"tenants", TenantSummary>
    >;
    listMyRoles: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      RoleSummary[]
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; sourceVersion: number },
      TargetTenantSyncStatus
    >;
    getTenant: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      TenantDetail | null
    >;
    listTenants: FunctionReference<
      "query",
      "public",
      Cursored<{ tokenIdentifier?: string; tenantId?: string; limit?: number }>,
      ComponentPage<"tenants", TenantDetail>
    >;
    listTenantUsers: FunctionReference<
      "query",
      "public",
      Cursored<{
        tokenIdentifier?: string;
        tenantId?: string;
        limit?: number;
        status?: MembershipStatus | "all";
      }>,
      ComponentPage<"users", TenantUser>
    >;
    getTenantUser: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; userId: string },
      TenantUser | null
    >;
    listTenantGroups: FunctionReference<
      "query",
      "public",
      Cursored<{ tokenIdentifier?: string; tenantId?: string; limit?: number }>,
      ComponentPage<"groups", TenantGroup>
    >;
    getTenantGroup: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; groupId: string },
      TenantGroup | null
    >;
    listGroupMembers: FunctionReference<
      "query",
      "public",
      Cursored<{ tokenIdentifier?: string; tenantId?: string; groupId: string; limit?: number }>,
      ComponentPage<"users", TenantUser>
    >;
    listTenantRoles: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      RoleSummary[]
    >;
    getTenantRole: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; roleId: string },
      RoleDetail | null
    >;
  };
  resources: {
    list: FunctionReference<
      "query",
      "public",
      Cursored<{
        tokenIdentifier?: string;
        tenantId?: string;
        type?: string;
        parent?: ResourceRef;
        permission?: string;
        limit?: number;
      }>,
      ComponentPage<"resources", ResourceNode>
    >;
    get: FunctionReference<
      "query",
      "public",
      {
        tokenIdentifier?: string;
        tenantId?: string;
        type: string;
        externalId: string;
        permission?: string;
      },
      ResourceNode | null
    >;
    write: FunctionReference<
      "mutation",
      "public",
      { tenantId?: string; type: string; externalId: string; parent?: ResourceRef; data?: unknown },
      ResourceNode | null
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { tenantId?: string; type: string; externalId: string },
      { deleted: boolean }
    >;
  };
};

export type CreateIamOptions<DataModel extends GenericDataModel> = {
  query: QueryBuilder<DataModel, "public">;
  mutation: MutationBuilder<DataModel, "public">;
  action: ActionBuilder<DataModel, "public">;
  components?: Record<string, unknown>;
  component?: IamComponent;
  componentName?: string;
};

// ── contexts ──────────────────────────────────────────────────────────────────
export type IamReadContext<DataModel extends GenericDataModel = GenericDataModel> =
  | Pick<GenericQueryCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery">;

export type IamWriteContext<DataModel extends GenericDataModel = GenericDataModel> =
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery" | "runMutation">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery" | "runMutation">;

type AnyCtx =
  | GenericQueryCtx<GenericDataModel>
  | GenericMutationCtx<GenericDataModel>
  | GenericActionCtx<GenericDataModel>;

// ── permission-guard selectors ────────────────────────────────────────────────
export type TenantSelector<Ctx, Args> =
  | string
  | ((ctx: Ctx, args: Args) => string | Promise<string>);

export type ResourceSelector<Ctx, Args> =
  | ResourceRef
  | ((ctx: Ctx, args: Args) => ResourceRef | Promise<ResourceRef>);

export type CanOptions = { tenant?: string; resource?: ResourceRef };

// ── auth-aware builders ────────────────────────────────────────────────────────
type GuardConfig<Ctx, Args> = {
  permission?: string;
  tenant?: TenantSelector<Ctx, Args>;
  resource?: ResourceSelector<Ctx, Args>;
};

export type AuthQueryBuilder<DataModel extends GenericDataModel> = <
  ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(query: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  permission?: string;
  tenant?: TenantSelector<GenericQueryCtx<DataModel>, OneOrZeroArgs[0]>;
  resource?: ResourceSelector<GenericQueryCtx<DataModel>, OneOrZeroArgs[0]>;
  handler: (ctx: GenericQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredQuery<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

export type AuthMutationBuilder<DataModel extends GenericDataModel> = <
  ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(mutation: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  permission?: string;
  tenant?: TenantSelector<GenericMutationCtx<DataModel>, OneOrZeroArgs[0]>;
  resource?: ResourceSelector<GenericMutationCtx<DataModel>, OneOrZeroArgs[0]>;
  handler: (ctx: GenericMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredMutation<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

export type AuthActionBuilder<DataModel extends GenericDataModel> = <
  ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(action: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  permission?: string;
  tenant?: TenantSelector<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
  resource?: ResourceSelector<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
  handler: (ctx: GenericActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredAction<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

// ── the createIam surface ──────────────────────────────────────────────────────
export type Iam<DataModel extends GenericDataModel> = {
  // Raw builders, no auth.
  publicQuery: QueryBuilder<DataModel, "public">;
  publicMutation: MutationBuilder<DataModel, "public">;
  publicAction: ActionBuilder<DataModel, "public">;
  // Auth-aware builders. Require a verified identity; add { permission, tenant?,
  // resource? } to also enforce a permission before the handler runs.
  query: AuthQueryBuilder<DataModel>;
  mutation: AuthMutationBuilder<DataModel>;
  action: AuthActionBuilder<DataModel>;
  // The signed-in end user's ID (their verified OIDC subject). Link app rows to this.
  getCurrentUserId: (ctx: IamReadContext<DataModel>) => Promise<string | undefined>;
  // In-handler authorization.
  iam: {
    can: (
      ctx: IamReadContext<DataModel>,
      permission: string,
      options?: CanOptions,
    ) => Promise<boolean>;
    require: (
      ctx: IamReadContext<DataModel>,
      permission: string,
      options?: CanOptions,
    ) => Promise<void>;
  };
  // Caller-centric reads.
  me: {
    tenants: (
      ctx: IamReadContext<DataModel>,
      args?: { cursor?: string; limit?: number; status?: "active" | "all" },
    ) => Promise<TenantSummariesPage>;
    roles: (ctx: IamReadContext<DataModel>, args?: { tenant?: string }) => Promise<RoleSummary[]>;
    accessStatus: (
      ctx: IamReadContext<DataModel>,
      args?: { tenant?: string },
    ) => Promise<IamTenantAccessStatusResult>;
  };
  // Mirror reads (admin reads self-gate on the matching system read capability).
  tenant: {
    list: (
      ctx: IamReadContext<DataModel>,
      args?: { tenant?: string; cursor?: string; limit?: number },
    ) => Promise<TenantDetailsPage>;
    get: (
      ctx: IamReadContext<DataModel>,
      args?: { tenant?: string },
    ) => Promise<TenantDetail | null>;
  };
  user: {
    list: (
      ctx: IamReadContext<DataModel>,
      args?: {
        tenant?: string;
        cursor?: string;
        limit?: number;
        status?: MembershipStatus | "all";
      },
    ) => Promise<TenantUsersPage>;
    get: (
      ctx: IamReadContext<DataModel>,
      args: { tenant?: string; userId: string },
    ) => Promise<TenantUser | null>;
  };
  group: {
    list: (
      ctx: IamReadContext<DataModel>,
      args?: { tenant?: string; cursor?: string; limit?: number },
    ) => Promise<TenantGroupsPage>;
    get: (
      ctx: IamReadContext<DataModel>,
      args: { tenant?: string; groupId: string },
    ) => Promise<TenantGroup | null>;
    members: (
      ctx: IamReadContext<DataModel>,
      args: { tenant?: string; groupId: string; cursor?: string; limit?: number },
    ) => Promise<TenantUsersPage>;
  };
  role: {
    list: (ctx: IamReadContext<DataModel>, args?: { tenant?: string }) => Promise<RoleSummary[]>;
    get: (
      ctx: IamReadContext<DataModel>,
      args: { tenant?: string; roleId: string },
    ) => Promise<RoleDetail | null>;
  };
  // Component-owned resource nodes (the app owns lifecycle).
  resource: {
    list: (
      ctx: IamReadContext<DataModel>,
      args?: {
        tenant?: string;
        type?: string;
        parent?: ResourceRef;
        permission?: string;
        cursor?: string;
        limit?: number;
      },
    ) => Promise<ResourceNodesPage>;
    get: (
      ctx: IamReadContext<DataModel>,
      args: { tenant?: string; type: string; externalId: string; permission?: string },
    ) => Promise<ResourceNode | null>;
    write: (
      ctx: IamWriteContext<DataModel>,
      args: {
        tenant?: string;
        type: string;
        externalId: string;
        parent?: ResourceRef;
        data?: unknown;
      },
    ) => Promise<ResourceNode | null>;
    delete: (
      ctx: IamWriteContext<DataModel>,
      args: { tenant?: string; type: string; externalId: string },
    ) => Promise<{ deleted: boolean }>;
  };
  // Whether the mirror has caught up to a specific control-plane write.
  syncStatus: (
    ctx: IamReadContext<DataModel>,
    args: { tenant?: string; sourceVersion: number },
  ) => Promise<TargetTenantSyncStatus>;
};

/**
 * Wires Hercules managed IAM into a Convex app. Call once in `convex/iam.ts`,
 * then re-export the returned helpers and builders.
 */
export function createIam<DataModel extends GenericDataModel>(
  options: CreateIamOptions<DataModel>,
): Iam<DataModel> {
  const component = resolveComponent(options);

  return {
    publicQuery: options.query,
    publicMutation: options.mutation,
    publicAction: options.action,
    query: makeAuthBuilder(options.query, component) as AuthQueryBuilder<DataModel>,
    mutation: makeAuthBuilder(options.mutation, component) as AuthMutationBuilder<DataModel>,
    action: makeAuthBuilder(options.action, component) as AuthActionBuilder<DataModel>,
    getCurrentUserId,
    iam: {
      can: (ctx, permission, opts) => can(component, ctx, permission, opts),
      require: (ctx, permission, opts) => requirePermission(component, ctx, permission, opts),
    },
    me: {
      tenants: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { tenants: [] };
        const result = await ctx.runQuery(component.queries.listMyTenants, {
          tokenIdentifier,
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
          ...optional("status", args.status),
        });
        return withNextCursor(result);
      },
      roles: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return [];
        return ctx.runQuery(component.queries.listMyRoles, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
      accessStatus: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { kind: "fallback", reason: "identity_missing" };
        return ctx.runQuery(component.queries.getTenantAccessStatus, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
    },
    tenant: {
      list: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { tenants: [] };
        const result = await ctx.runQuery(component.queries.listTenants, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
        });
        return withNextCursor(result);
      },
      get: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return null;
        return ctx.runQuery(component.queries.getTenant, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
    },
    user: {
      list: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { users: [] };
        const result = await ctx.runQuery(component.queries.listTenantUsers, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
          ...optional("status", args.status),
        });
        return withNextCursor(result);
      },
      get: async (ctx, args) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return null;
        return ctx.runQuery(component.queries.getTenantUser, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          userId: args.userId,
        });
      },
    },
    group: {
      list: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { groups: [] };
        const result = await ctx.runQuery(component.queries.listTenantGroups, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
        });
        return withNextCursor(result);
      },
      get: async (ctx, args) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return null;
        return ctx.runQuery(component.queries.getTenantGroup, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          groupId: args.groupId,
        });
      },
      members: async (ctx, args) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { users: [] };
        const result = await ctx.runQuery(component.queries.listGroupMembers, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          groupId: args.groupId,
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
        });
        return withNextCursor(result);
      },
    },
    role: {
      list: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return [];
        return ctx.runQuery(component.queries.listTenantRoles, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
      get: async (ctx, args) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return null;
        return ctx.runQuery(component.queries.getTenantRole, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
          roleId: args.roleId,
        });
      },
    },
    resource: {
      list: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        const result = await ctx.runQuery(component.resources.list, {
          ...optional("tokenIdentifier", tokenIdentifier),
          ...optional("tenantId", args.tenant),
          ...optional("type", args.type),
          ...optional("parent", args.parent),
          ...optional("permission", args.permission),
          ...optional("cursor", args.cursor),
          ...optional("limit", args.limit),
        });
        return withNextCursor(result);
      },
      get: async (ctx, args) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        return ctx.runQuery(component.resources.get, {
          ...optional("tokenIdentifier", tokenIdentifier),
          ...optional("tenantId", args.tenant),
          type: args.type,
          externalId: args.externalId,
          ...optional("permission", args.permission),
        });
      },
      write: async (ctx, args) =>
        ctx.runMutation(component.resources.write, {
          ...optional("tenantId", args.tenant),
          type: args.type,
          externalId: args.externalId,
          ...optional("parent", args.parent),
          ...optional("data", args.data),
        }),
      delete: async (ctx, args) =>
        ctx.runMutation(component.resources.remove, {
          ...optional("tenantId", args.tenant),
          type: args.type,
          externalId: args.externalId,
        }),
    },
    syncStatus: async (ctx, args) => {
      const tokenIdentifier = await getTokenIdentifier(ctx);
      return ctx.runQuery(component.queries.getTargetTenantSyncStatus, {
        ...optional("tokenIdentifier", tokenIdentifier),
        ...optional("tenantId", args.tenant),
        sourceVersion: args.sourceVersion,
      });
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function withNextCursor<T extends { cursor?: string }>(
  result: T,
): Omit<T, "cursor"> & { nextCursor?: string } {
  const { cursor, ...rest } = result;
  return {
    ...(rest as Omit<T, "cursor">),
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  };
}

function resolveComponent<DataModel extends GenericDataModel>(
  options: CreateIamOptions<DataModel>,
): IamComponent {
  if (options.component) return options.component;
  const componentName = options.componentName ?? "hercules";
  const component = options.components?.[componentName];
  if (!component) {
    throw new Error(
      "Missing Hercules IAM component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }
  return component as IamComponent;
}

async function getTokenIdentifier(ctx: IamReadContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? undefined;
}

async function getCurrentUserId(ctx: IamReadContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.subject ?? undefined;
}

async function can(
  component: IamComponent,
  ctx: IamReadContext,
  permission: string,
  options?: CanOptions,
): Promise<boolean> {
  const decision = await runCheck(component, ctx, permission, options);
  return decision.allowed;
}

async function requirePermission(
  component: IamComponent,
  ctx: IamReadContext,
  permission: string,
  options?: CanOptions,
): Promise<void> {
  const decision = await runCheck(component, ctx, permission, options);
  if (!decision.allowed) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "Access denied",
      reasonCode: decision.reasonCode,
      ...(decision.sourceVersion === undefined ? {} : { sourceVersion: decision.sourceVersion }),
    });
  }
}

async function runCheck(
  component: IamComponent,
  ctx: IamReadContext,
  permission: string,
  options?: CanOptions,
): Promise<AccessDecision> {
  const tokenIdentifier = await getTokenIdentifier(ctx);
  if (!tokenIdentifier) {
    return { allowed: false, reasonCode: "missing_identity" };
  }
  return ctx.runQuery(component.checks.check, {
    tokenIdentifier,
    ...optional("tenantId", options?.tenant),
    permission,
    ...optional("resource", options?.resource),
  });
}

function makeAuthBuilder<TBuilder>(builder: TBuilder, component: IamComponent): TBuilder {
  return ((definition: unknown) => {
    if (typeof definition !== "object" || definition === null || !("handler" in definition)) {
      throw new Error("Auth-aware builders require an object definition with a handler.");
    }
    const def = definition as {
      handler: (ctx: AnyCtx, ...args: never[]) => unknown;
      permission?: unknown;
      tenant?: unknown;
      resource?: unknown;
      args?: unknown;
      returns?: unknown;
    };
    const { permission, tenant, resource, handler, ...convexDefinition } = def;
    const guard: GuardConfig<AnyCtx, unknown> = {
      ...(typeof permission === "string" ? { permission } : {}),
      ...(tenant === undefined ? {} : { tenant: tenant as TenantSelector<AnyCtx, unknown> }),
      ...(resource === undefined
        ? {}
        : { resource: resource as ResourceSelector<AnyCtx, unknown> }),
    };
    return (builder as (def: unknown) => unknown)({
      ...convexDefinition,
      handler: async (ctx: AnyCtx, ...args: never[]) => {
        await ensureAuthorized(component, ctx, guard, args[0]);
        return handler(ctx, ...args);
      },
    });
  }) as TBuilder;
}

async function ensureAuthorized(
  component: IamComponent,
  ctx: AnyCtx,
  guard: GuardConfig<AnyCtx, unknown>,
  callerArgs: unknown,
): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier) {
    throw new ConvexError({
      code: guard.permission ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      message: guard.permission ? "Access denied" : "Authentication required",
      reasonCode: "missing_identity",
    });
  }
  if (!guard.permission) return;

  let tenant: string | undefined;
  let resource: ResourceRef | undefined;
  try {
    if (guard.tenant !== undefined) {
      tenant =
        typeof guard.tenant === "function" ? await guard.tenant(ctx, callerArgs) : guard.tenant;
    }
    if (guard.resource !== undefined) {
      resource =
        typeof guard.resource === "function"
          ? await guard.resource(ctx, callerArgs)
          : guard.resource;
    }
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "authorization target resolution failed",
      reasonCode: "target_resolution_failed",
    });
  }

  const decision = await ctx.runQuery(component.checks.check, {
    tokenIdentifier: identity.tokenIdentifier,
    ...optional("tenantId", tenant),
    permission: guard.permission,
    ...optional("resource", resource),
  });
  if (!decision.allowed) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "Access denied",
      reasonCode: decision.reasonCode,
      ...(decision.sourceVersion === undefined ? {} : { sourceVersion: decision.sourceVersion }),
    });
  }
}
