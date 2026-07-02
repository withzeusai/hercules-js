import type {
  ActionBuilder,
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
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
export { classifyAccessError } from "./access-errors.js";
export type { AccessAdmissionStatus, AccessErrorClassification } from "./access-errors.js";

// ── shared model types (match the component return shapes) ────────────────────
export type MembershipStatus = "active" | "blocked" | "suspended" | "pending_approval" | "removed";

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  isAppScope: boolean;
  // Tenant scope, read together with isAppScope:
  //   • tenantId = <id>                  → TENANT-SCOPED: usable only in that tenant.
  //   • tenantId = null, isAppScope=false → SHARED: usable in every tenant.
  //   • tenantId = null, isAppScope=true  → APP-SCOPED: app-wide authority,
  //     grantable only to primary-tenant members.
  tenantId: string | null;
};

export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  isPrimaryTenant: boolean;
  accessStatus: MembershipStatus;
  lifecycleStatus: "active" | "archived";
  roles: RoleSummary[];
};

export type TenantSummariesPage = { tenants: TenantSummary[]; nextCursor?: string };

// The caller's own groups in a tenant (me.groups).
export type GroupSummary = {
  groupId: string;
  name: string;
  status: "active" | "disabled";
};

export type ResourceRef = { type: string; externalId: string };

export type ResourceNode = {
  type: string;
  externalId: string;
  parent?: ResourceRef;
};

export type ResourceNodesPage = { resources: ResourceNode[]; nextCursor?: string };

// ── mirror-table record shapes ────────────────────────────────────────────────
// The generic per-table reads return these clean projections: the Convex system
// fields (_id, _creationTime) and the internal sourceVersion are dropped.
export type TenantRecord = {
  id: string;
  name: string;
  isPrimaryTenant: boolean;
  status: "active" | "disabled";
  accountEntryMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string | null;
  updatedAt: number;
};

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string;
  phone?: string;
  phoneVerified: boolean;
  updatedAt: number;
};

export type TenantMembershipRecord = {
  id: string;
  tenantId: string;
  userId: string;
  status: MembershipStatus;
  updatedAt: number;
};

export type GroupRecord = {
  id: string;
  tenantId: string;
  description?: string;
  name: string;
  status: "active" | "disabled";
  updatedAt: number;
};

export type GroupMembershipRecord = {
  groupId: string;
  membershipId: string;
  tenantId: string;
  updatedAt: number;
};

export type RoleRecord = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  tenantId: string | null;
  isAppScope: boolean;
  updatedAt: number;
};

export type PermissionRecord = {
  id: string;
  key: string;
  isAppScope: boolean;
  updatedAt: number;
};

export type RolePermissionRecord = {
  roleId: string;
  permissionId: string;
  updatedAt: number;
};

export type ResourceTypeRecord = {
  id: string;
  key: string;
  name: string;
  parentResourceTypeId: string | null;
  updatedAt: number;
};

export type UserRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  expiresAt?: number;
  updatedAt: number;
};

export type GroupRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  groupId: string;
  roleId: string;
  expiresAt?: number;
  updatedAt: number;
};

export type UserResourceRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  resourceTypeId: string;
  externalId: string;
  expiresAt?: number;
  updatedAt: number;
};

export type GroupResourceRoleAssignmentRecord = {
  id: string;
  tenantId: string;
  groupId: string;
  roleId: string;
  resourceTypeId: string;
  externalId: string;
  expiresAt?: number;
  updatedAt: number;
};

// A page from a generic `list` read: bounded items plus an opaque `nextCursor`
// (present only when more pages exist; pass it back as `cursor`).
export type ListPage<V> = { items: V[]; nextCursor?: string };

export type TenantAccessStatusResult =
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
type PageFilters = { cursor?: string; limit?: number };
type ComponentItemsPage<V> = { items: V[]; cursor?: string };

// The two generic per-table read references, keyed by their filter/key args and
// record type. `list` refs carry the pagination args on top of their filters.
type CompList<Filters extends DefaultFunctionArgs, V> = FunctionReference<
  "query",
  "public",
  Filters & PageFilters,
  ComponentItemsPage<V>
>;
type CompGet<Args extends DefaultFunctionArgs, V> = FunctionReference<
  "query",
  "public",
  Args,
  V | null
>;

export type AccessComponent = {
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
    // Caller-centric reads (me.*) and sync status.
    getTenantAccessStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      TenantAccessStatusResult
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
    listMyGroups: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string },
      GroupSummary[]
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; tenantId?: string; sourceVersion: number },
      TargetTenantSyncStatus
    >;

    // Generic per-table reads (TRUSTED / UNGATED).
    tenantsList: CompList<
      { status?: "active" | "disabled"; isPrimaryTenant?: boolean },
      TenantRecord
    >;
    tenantsGet: CompGet<{ id?: string; primary?: boolean }, TenantRecord>;
    usersList: CompList<{ email?: string }, UserRecord>;
    usersGet: CompGet<{ id?: string; email?: string }, UserRecord>;
    groupsList: CompList<{ tenantId?: string; status?: "active" | "disabled" }, GroupRecord>;
    groupsGet: CompGet<{ id: string }, GroupRecord>;
    rolesList: CompList<{ tenantId?: string | null; isAppScope?: boolean }, RoleRecord>;
    rolesGet: CompGet<{ id?: string; key?: string; tenantId?: string | null }, RoleRecord>;
    permissionsList: CompList<{ isAppScope?: boolean }, PermissionRecord>;
    permissionsGet: CompGet<{ id?: string; key?: string }, PermissionRecord>;
    resourceTypesList: CompList<{ parentResourceTypeId?: string | null }, ResourceTypeRecord>;
    resourceTypesGet: CompGet<{ id?: string; key?: string }, ResourceTypeRecord>;
    tenantMembershipsList: CompList<
      { tenantId?: string; status?: MembershipStatus; userId?: string },
      TenantMembershipRecord
    >;
    tenantMembershipsGet: CompGet<{ id?: string; tenantId?: string; userId?: string }, TenantMembershipRecord>;
    userRoleAssignmentsList: CompList<
      { tenantId?: string; membershipId?: string; roleId?: string },
      UserRoleAssignmentRecord
    >;
    userRoleAssignmentsGet: CompGet<{ id: string }, UserRoleAssignmentRecord>;
    groupRoleAssignmentsList: CompList<
      { tenantId?: string; groupId?: string; roleId?: string },
      GroupRoleAssignmentRecord
    >;
    groupRoleAssignmentsGet: CompGet<{ id: string }, GroupRoleAssignmentRecord>;
    userResourceRoleAssignmentsList: CompList<
      {
        tenantId?: string;
        membershipId?: string;
        roleId?: string;
        resourceTypeId?: string;
        externalId?: string;
      },
      UserResourceRoleAssignmentRecord
    >;
    userResourceRoleAssignmentsGet: CompGet<{ id: string }, UserResourceRoleAssignmentRecord>;
    groupResourceRoleAssignmentsList: CompList<
      {
        tenantId?: string;
        groupId?: string;
        roleId?: string;
        resourceTypeId?: string;
        externalId?: string;
      },
      GroupResourceRoleAssignmentRecord
    >;
    groupResourceRoleAssignmentsGet: CompGet<{ id: string }, GroupResourceRoleAssignmentRecord>;
    groupMembershipsList: CompList<
      { groupId?: string; membershipId?: string; tenantId?: string },
      GroupMembershipRecord
    >;
    groupMembershipsGet: CompGet<{ groupId: string; membershipId: string }, GroupMembershipRecord>;
    rolePermissionsList: CompList<{ roleId?: string; permissionId?: string }, RolePermissionRecord>;
    rolePermissionsGet: CompGet<{ roleId: string; permissionId: string }, RolePermissionRecord>;
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
      { tenantId?: string; type: string; externalId: string; parent?: ResourceRef },
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

export type CreateAccessOptions<DataModel extends GenericDataModel> = {
  query: QueryBuilder<DataModel, "public">;
  mutation: MutationBuilder<DataModel, "public">;
  action: ActionBuilder<DataModel, "public">;
  components?: Record<string, unknown>;
  component?: AccessComponent;
  componentName?: string;
};

// ── contexts ──────────────────────────────────────────────────────────────────
export type AccessReadContext<DataModel extends GenericDataModel = GenericDataModel> =
  | Pick<GenericQueryCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery">;

export type AccessWriteContext<DataModel extends GenericDataModel = GenericDataModel> =
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

export type PermissionOptions = { tenant?: string; resource?: ResourceRef };

// A permission requirement is either a single permission key, a bare array
// (treated as `allOf`), or a set combined with explicit AND/OR semantics:
//   • `"app.x:read"`            - hold this one permission.
//   • `["a", "b"]`              - hold EVERY ONE (AND), shorthand for allOf.
//   • `{ anyOf: ["a", "b"] }`   - hold AT LEAST ONE (OR).
//   • `{ allOf: ["a", "b"] }`   - hold EVERY ONE (AND).
// An empty array / `anyOf` / `allOf` is rejected as a misconfiguration (denied).
export type PermissionRequirement =
  | string
  | string[]
  | { anyOf: string[]; allOf?: never }
  | { allOf: string[]; anyOf?: never };

// ── auth-aware builders ────────────────────────────────────────────────────────
type GuardConfig<Ctx, Args> = {
  permission?: PermissionRequirement;
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
  permission?: PermissionRequirement;
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
  permission?: PermissionRequirement;
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
  permission?: PermissionRequirement;
  tenant?: TenantSelector<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
  resource?: ResourceSelector<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
  handler: (ctx: GenericActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredAction<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

// The uniform list/get pair a mirror-table namespace exposes.
type TableReads<DataModel extends GenericDataModel, Filters, Key, Rec> = {
  list: (
    ctx: AccessReadContext<DataModel>,
    filters?: Filters & { cursor?: string; limit?: number },
  ) => Promise<ListPage<Rec>>;
  get: (ctx: AccessReadContext<DataModel>, key: Key) => Promise<Rec | null>;
};

// ── the createAccess surface ──────────────────────────────────────────────────────
export type Access<DataModel extends GenericDataModel> = {
  // Auth-aware builders. Require a verified identity; add { permission, tenant?,
  // resource? } to also enforce a permission before the handler runs. For
  // non-protected functions, import the raw query/mutation/action from
  // _generated/server directly.
  protectedQuery: AuthQueryBuilder<DataModel>;
  protectedMutation: AuthMutationBuilder<DataModel>;
  protectedAction: AuthActionBuilder<DataModel>;
  // In-handler authorization. `requirement` accepts a single key, a bare array
  // (allOf / AND), or an { anyOf } / { allOf } set (see PermissionRequirement).
  hasPermissions: (
    ctx: AccessReadContext<DataModel>,
    requirement: PermissionRequirement,
    options?: PermissionOptions,
  ) => Promise<boolean>;
  requirePermissions: (
    ctx: AccessReadContext<DataModel>,
    requirement: PermissionRequirement,
    options?: PermissionOptions,
  ) => Promise<void>;
  // Caller-centric reads.
  me: {
    // The signed-in end user's ID (their verified OIDC subject). Link app rows
    // to this. `undefined` when unauthenticated.
    id: (ctx: AccessReadContext<DataModel>) => Promise<string | undefined>;
    tenants: (
      ctx: AccessReadContext<DataModel>,
      args?: { cursor?: string; limit?: number; status?: "active" | "all" },
    ) => Promise<TenantSummariesPage>;
    roles: (
      ctx: AccessReadContext<DataModel>,
      args?: { tenant?: string },
    ) => Promise<RoleSummary[]>;
    groups: (
      ctx: AccessReadContext<DataModel>,
      args?: { tenant?: string },
    ) => Promise<GroupSummary[]>;
    accessStatus: (
      ctx: AccessReadContext<DataModel>,
      args?: { tenant?: string },
    ) => Promise<TenantAccessStatusResult>;
  };
  // Generic, uniform mirror reads. These are TRUSTED reads with no identity
  // check: authorize the calling function (protectedQuery + requirePermissions).
  tenants: TableReads<
    DataModel,
    { status?: "active" | "disabled"; isPrimaryTenant?: boolean },
    { id: string } | { primary: true },
    TenantRecord
  >;
  users: TableReads<DataModel, { email?: string }, { id: string } | { email: string }, UserRecord>;
  groups: TableReads<
    DataModel,
    { tenantId?: string; status?: "active" | "disabled" },
    { id: string },
    GroupRecord
  >;
  roles: TableReads<
    DataModel,
    { tenantId?: string | null; isAppScope?: boolean },
    { id: string } | { key: string; tenantId?: string | null },
    RoleRecord
  >;
  permissions: TableReads<
    DataModel,
    { isAppScope?: boolean },
    { id: string } | { key: string },
    PermissionRecord
  >;
  resourceTypes: TableReads<
    DataModel,
    { parentResourceTypeId?: string | null },
    { id: string } | { key: string },
    ResourceTypeRecord
  >;
  tenantMemberships: TableReads<
    DataModel,
    { tenantId?: string; status?: MembershipStatus; userId?: string },
    { id: string } | { tenantId: string; userId: string },
    TenantMembershipRecord
  >;
  userRoleAssignments: TableReads<
    DataModel,
    { tenantId?: string; membershipId?: string; roleId?: string },
    { id: string },
    UserRoleAssignmentRecord
  >;
  groupRoleAssignments: TableReads<
    DataModel,
    { tenantId?: string; groupId?: string; roleId?: string },
    { id: string },
    GroupRoleAssignmentRecord
  >;
  userResourceRoleAssignments: TableReads<
    DataModel,
    {
      tenantId?: string;
      membershipId?: string;
      roleId?: string;
      resourceTypeId?: string;
      externalId?: string;
    },
    { id: string },
    UserResourceRoleAssignmentRecord
  >;
  groupResourceRoleAssignments: TableReads<
    DataModel,
    {
      tenantId?: string;
      groupId?: string;
      roleId?: string;
      resourceTypeId?: string;
      externalId?: string;
    },
    { id: string },
    GroupResourceRoleAssignmentRecord
  >;
  groupMemberships: TableReads<
    DataModel,
    { groupId?: string; membershipId?: string; tenantId?: string },
    { groupId: string; membershipId: string },
    GroupMembershipRecord
  >;
  rolePermissions: TableReads<
    DataModel,
    { roleId?: string; permissionId?: string },
    { roleId: string; permissionId: string },
    RolePermissionRecord
  >;
  // Component-owned resource nodes (the app owns lifecycle).
  resource: {
    list: (
      ctx: AccessReadContext<DataModel>,
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
      ctx: AccessReadContext<DataModel>,
      args: { tenant?: string; type: string; externalId: string; permission?: string },
    ) => Promise<ResourceNode | null>;
    write: (
      ctx: AccessWriteContext<DataModel>,
      args: {
        tenant?: string;
        type: string;
        externalId: string;
        parent?: ResourceRef;
      },
    ) => Promise<ResourceNode | null>;
    delete: (
      ctx: AccessWriteContext<DataModel>,
      args: { tenant?: string; type: string; externalId: string },
    ) => Promise<{ deleted: boolean }>;
  };
  // Whether the mirror has caught up to a specific control-plane write.
  syncStatus: (
    ctx: AccessReadContext<DataModel>,
    args: { tenant?: string; sourceVersion: number },
  ) => Promise<TargetTenantSyncStatus>;
};

/**
 * Wires Hercules managed access control into a Convex app. Call once in
 * `convex/access.ts`, then re-export the returned helpers and builders.
 */
export function createAccess<DataModel extends GenericDataModel>(
  options: CreateAccessOptions<DataModel>,
): Access<DataModel> {
  const component = resolveComponent(options);
  const q = component.queries;

  // A generic list wrapper: forward the (compacted) filters, then rename the
  // component's `cursor` to `nextCursor`. `Args` is inferred whole from the ref
  // (filters + pagination), so the intersection stays out of inference.
  const list =
    <Args extends DefaultFunctionArgs, V>(
      ref: FunctionReference<"query", "public", Args, ComponentItemsPage<V>>,
    ) =>
    async (ctx: AccessReadContext<DataModel>, filters?: Args): Promise<ListPage<V>> =>
      withItemsCursor(await ctx.runQuery(ref, compact((filters ?? {}) as Args)));

  const get =
    <Args extends DefaultFunctionArgs, V>(
      ref: FunctionReference<"query", "public", Args, V | null>,
    ) =>
    async (ctx: AccessReadContext<DataModel>, key: Args): Promise<V | null> =>
      ctx.runQuery(ref, key);

  return {
    protectedQuery: makeAuthBuilder(options.query, component) as AuthQueryBuilder<DataModel>,
    protectedMutation: makeAuthBuilder(
      options.mutation,
      component,
    ) as AuthMutationBuilder<DataModel>,
    protectedAction: makeAuthBuilder(options.action, component) as AuthActionBuilder<DataModel>,
    hasPermissions: (ctx, requirement, opts) => hasPermissions(component, ctx, requirement, opts),
    requirePermissions: (ctx, requirement, opts) =>
      requirePermissions(component, ctx, requirement, opts),
    me: {
      id: (ctx) => getCurrentUserId(ctx),
      tenants: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { tenants: [] };
        const result = await ctx.runQuery(q.listMyTenants, {
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
        return ctx.runQuery(q.listMyRoles, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
      groups: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return [];
        return ctx.runQuery(q.listMyGroups, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
      accessStatus: async (ctx, args = {}) => {
        const tokenIdentifier = await getTokenIdentifier(ctx);
        if (!tokenIdentifier) return { kind: "fallback", reason: "identity_missing" };
        return ctx.runQuery(q.getTenantAccessStatus, {
          tokenIdentifier,
          ...optional("tenantId", args.tenant),
        });
      },
    },
    tenants: { list: list(q.tenantsList), get: get(q.tenantsGet) },
    users: { list: list(q.usersList), get: get(q.usersGet) },
    groups: { list: list(q.groupsList), get: get(q.groupsGet) },
    roles: { list: list(q.rolesList), get: get(q.rolesGet) },
    permissions: { list: list(q.permissionsList), get: get(q.permissionsGet) },
    resourceTypes: { list: list(q.resourceTypesList), get: get(q.resourceTypesGet) },
    tenantMemberships: { list: list(q.tenantMembershipsList), get: get(q.tenantMembershipsGet) },
    userRoleAssignments: { list: list(q.userRoleAssignmentsList), get: get(q.userRoleAssignmentsGet) },
    groupRoleAssignments: {
      list: list(q.groupRoleAssignmentsList),
      get: get(q.groupRoleAssignmentsGet),
    },
    userResourceRoleAssignments: {
      list: list(q.userResourceRoleAssignmentsList),
      get: get(q.userResourceRoleAssignmentsGet),
    },
    groupResourceRoleAssignments: {
      list: list(q.groupResourceRoleAssignmentsList),
      get: get(q.groupResourceRoleAssignmentsGet),
    },
    groupMemberships: { list: list(q.groupMembershipsList), get: get(q.groupMembershipsGet) },
    rolePermissions: { list: list(q.rolePermissionsList), get: get(q.rolePermissionsGet) },
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
      return ctx.runQuery(q.getTargetTenantSyncStatus, {
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

// Drop undefined-valued keys so an omitted filter is not sent as an explicit
// `undefined` (which fails a Convex optional-arg validator).
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
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

function withItemsCursor<V>(result: ComponentItemsPage<V>): ListPage<V> {
  return {
    items: result.items,
    ...(result.cursor === undefined ? {} : { nextCursor: result.cursor }),
  };
}

function resolveComponent<DataModel extends GenericDataModel>(
  options: CreateAccessOptions<DataModel>,
): AccessComponent {
  if (options.component) return options.component;
  const componentName = options.componentName ?? "hercules";
  const component = options.components?.[componentName];
  if (!component) {
    throw new Error(
      "Missing Hercules IAM component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }
  return component as AccessComponent;
}

async function getTokenIdentifier(ctx: AccessReadContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? undefined;
}

async function getCurrentUserId(ctx: AccessReadContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.subject ?? undefined;
}

async function hasPermissions(
  component: AccessComponent,
  ctx: AccessReadContext,
  requirement: PermissionRequirement,
  options?: PermissionOptions,
): Promise<boolean> {
  const decision = await runCheck(component, ctx, requirement, options);
  return decision.allowed;
}

async function requirePermissions(
  component: AccessComponent,
  ctx: AccessReadContext,
  requirement: PermissionRequirement,
  options?: PermissionOptions,
): Promise<void> {
  const decision = await runCheck(component, ctx, requirement, options);
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
  component: AccessComponent,
  ctx: AccessReadContext,
  requirement: PermissionRequirement,
  options?: PermissionOptions,
): Promise<AccessDecision> {
  const tokenIdentifier = await getTokenIdentifier(ctx);
  if (!tokenIdentifier) {
    return { allowed: false, reasonCode: "missing_identity" };
  }
  return evaluateRequirement(
    component,
    ctx,
    tokenIdentifier,
    requirement,
    options?.tenant,
    options?.resource,
  );
}

// Splits a PermissionRequirement into its mode and the keys to check. A bare
// string is a single AND of one key; a bare array is an allOf.
function requirementKeys(requirement: PermissionRequirement): {
  mode: "anyOf" | "allOf";
  keys: string[];
} {
  if (typeof requirement === "string") return { mode: "allOf", keys: [requirement] };
  if (Array.isArray(requirement)) return { mode: "allOf", keys: requirement };
  if ("anyOf" in requirement && requirement.anyOf !== undefined) {
    return { mode: "anyOf", keys: requirement.anyOf };
  }
  return { mode: "allOf", keys: requirement.allOf };
}

// Resolves a PermissionRequirement to a single decision. One key uses the
// cheaper `check`; a set fans out to `checkMany` and combines with anyOf=OR
// (allowed if any allow) / allOf=AND (denied at the first deny).
async function evaluateRequirement(
  component: AccessComponent,
  ctx: AccessReadContext,
  tokenIdentifier: string,
  requirement: PermissionRequirement,
  tenantId: string | undefined,
  resource: ResourceRef | undefined,
): Promise<AccessDecision> {
  const { mode, keys } = requirementKeys(requirement);
  if (keys.length === 0) {
    return { allowed: false, reasonCode: "empty_permission_set" };
  }
  if (keys.length === 1) {
    return ctx.runQuery(component.checks.check, {
      tokenIdentifier,
      ...optional("tenantId", tenantId),
      permission: keys[0] as string,
      ...optional("resource", resource),
    });
  }
  const decisions = await ctx.runQuery(component.checks.checkMany, {
    tokenIdentifier,
    checks: keys.map(
      (key): Omit<CheckArgs, "tokenIdentifier"> => ({
        ...optional("tenantId", tenantId),
        permission: key,
        ...optional("resource", resource),
      }),
    ),
  });
  const fallback: AccessDecision = { allowed: false, reasonCode: "access_denied" };
  if (mode === "anyOf") {
    // OR: the first allow wins; otherwise surface the first denial.
    return decisions.find((decision) => decision.allowed) ?? decisions[0] ?? fallback;
  }
  // AND: the first denial wins; otherwise any allow decision is representative.
  return decisions.find((decision) => !decision.allowed) ?? decisions[0] ?? fallback;
}

function makeAuthBuilder<TBuilder>(builder: TBuilder, component: AccessComponent): TBuilder {
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
      ...(isPermissionRequirement(permission) ? { permission } : {}),
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
  component: AccessComponent,
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

  const decision = await evaluateRequirement(
    component,
    ctx,
    identity.tokenIdentifier,
    guard.permission,
    tenant,
    resource,
  );
  if (!decision.allowed) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "Access denied",
      reasonCode: decision.reasonCode,
      ...(decision.sourceVersion === undefined ? {} : { sourceVersion: decision.sourceVersion }),
    });
  }
}

function isPermissionRequirement(value: unknown): value is PermissionRequirement {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { anyOf?: unknown; allOf?: unknown };
  return Array.isArray(candidate.anyOf) || Array.isArray(candidate.allOf);
}
