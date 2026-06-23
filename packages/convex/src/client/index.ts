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

export type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  explicitDeny?: boolean;
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
  ancestors?: Array<{ resourceType: string; resourceId: string }>;
};
type AuthorizationCheckArgs = Omit<AuthorizationArgs, "tokenIdentifier"> & {
  permission: string;
};

type ListMyMembershipsArgs = { tokenIdentifier?: string };
type GetDeploymentEntryStatusArgs = { tokenIdentifier?: string };
type ListMyRolesArgs = { tokenIdentifier?: string; scopeId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: Array<{ resourceType: string; resourceId: string }>;
};

type ListScopeArgs = { tokenIdentifier?: string; scopeId: string };
type ListScopeMemberDirectoryArgs = ListScopeArgs & {
  cursor?: string;
  limit?: number;
};
type GetScopeMemberDirectoryEntryArgs = ListScopeArgs & {
  principalId?: string;
  herculesAuthUserId?: string;
};

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

/** One scope returned by `listMyMemberships`. Select the default scope by `kind`, not array order. */
export type Membership = {
  scopeId: string;
  scopeName: string;
  kind: ScopeKind;
  roles: RoleSummary[];
  joinedAt: number;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
};

export type AccessPrincipalStatus =
  | "active"
  | "blocked"
  | "suspended"
  | "pending_approval"
  | "removed";

export type AccessDeploymentEntryMirrorResult =
  | {
      kind: "principal";
      principalId: string;
      status: AccessPrincipalStatus;
      stateVersion: number;
    }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "default_scope_missing"
        | "principal_missing";
      stateVersion?: number;
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

/** One member returned directly by `listScopeMembers`. Role assignments are in `roles`. */
export type ScopeMember = {
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  // A user member's name/email/image come from the deployment-wide user row;
  // a group member's name is the group's own display name.
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
};

/** One user in a `listScopeMemberDirectory` page. Only directory entries expose `roleKeys`. */
export type ScopeMemberDirectoryEntry = {
  principalId: string;
  herculesAuthUserId: string;
  name: string;
  email: string;
  image?: string;
  roleKeys: string[];
};

export type ScopeMemberDirectoryPage = {
  members: ScopeMemberDirectoryEntry[];
  nextCursor?: string;
};

/** One catalog role returned by `listScopeRoles`. Use `roleKey` and `roleName` for display only. */
export type ScopeRoleSummary = RoleSummary & { shared: boolean };

export type ScopePermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

export type DirectResourceSubject = {
  grantId: string;
  principalId: string;
  type: "user" | "group";
  herculesAuthUserId?: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  // A user subject's name/email/image come from the deployment-wide user row;
  // a group subject's name is the group's own display name.
  name?: string;
  email?: string;
  image?: string;
  effect: "allow" | "deny";
  appliesTo: "self" | "self_and_descendants";
  expiresAt?: number;
  roleId?: string;
  roleKey?: string;
  roleName?: string;
  permissionId?: string;
  permissionKey?: string;
};

type ListDirectSubjectsArgs = {
  tokenIdentifier?: string;
  scopeId: string;
  resourceType: string;
  resourceId: string;
  permission: string;
};

export type AccessContext<DataModel extends GenericDataModel = any> =
  | Pick<GenericQueryCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery">;

export type AccessResourceRef = { type: string; id?: string };
export type AccessAuthorizationAncestor = { type: string; id: string };

export type AccessControlComponent = {
  checks: {
    authorize: FunctionReference<"query", "public", AuthorizationArgs, AuthorizationDecision>;
    authorizeMany: FunctionReference<
      "query",
      "public",
      { tokenIdentifier?: string; checks: AuthorizationCheckArgs[] },
      AuthorizationDecision[]
    >;
  };
  queries: {
    getDeploymentEntryStatus: FunctionReference<
      "query",
      "public",
      GetDeploymentEntryStatusArgs,
      AccessDeploymentEntryMirrorResult
    >;
    listMyMemberships: FunctionReference<"query", "public", ListMyMembershipsArgs, Membership[]>;
    listMyRoles: FunctionReference<"query", "public", ListMyRolesArgs, RoleSummary[]>;
    getEffectivePermissions: FunctionReference<
      "query",
      "public",
      GetEffectivePermissionsArgs,
      EffectivePermissionsResult
    >;
    listScopeMembers: FunctionReference<"query", "public", ListScopeArgs, ScopeMember[]>;
    listScopeMemberDirectory: FunctionReference<
      "query",
      "public",
      ListScopeMemberDirectoryArgs,
      { members: ScopeMemberDirectoryEntry[]; cursor?: string }
    >;
    getScopeMemberDirectoryEntry: FunctionReference<
      "query",
      "public",
      GetScopeMemberDirectoryEntryArgs,
      ScopeMemberDirectoryEntry | null
    >;
    listScopeRoles: FunctionReference<"query", "public", ListScopeArgs, ScopeRoleSummary[]>;
    listScopePermissions: FunctionReference<
      "query",
      "public",
      ListScopeArgs,
      ScopePermissionSummary[]
    >;
    listDirectSubjectsForResource: FunctionReference<
      "query",
      "public",
      ListDirectSubjectsArgs,
      DirectResourceSubject[]
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
  | {
      scopeId: string;
      resourceType?: string;
      resourceId?: string;
      ancestors?: Array<{ resourceType: string; resourceId: string }>;
    };

export type ExtractScope<Ctx, Args> = (
  ctx: Ctx,
  args: Args,
) => ExtractedScope | Promise<ExtractedScope>;

// Hard cap on resource-hierarchy depth: a request authorizes against the
// resource plus at most this many ancestors. Generous for real nesting
// (folder/file, project/task/comment) while bounding the per-call check count.
const MAX_AUTHORIZE_CHAIN = 10;

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
  checkPermissions: (
    ctx: AccessContext<DataModel>,
    checks: Array<Exclude<PermissionCheckArgs, string>>,
  ) => Promise<AuthorizationDecision[]>;
  /**
   * Return the current user's canonical Hercules Auth id (`sub`) from the
   * verified Convex identity. Use this to link app-owned profile or domain
   * rows to the signed-in user instead of parsing `tokenIdentifier`.
   */
  getCurrentHerculesAuthUserId: (ctx: AccessContext<DataModel>) => Promise<string | undefined>;
  getDeploymentEntryStatus: (
    ctx: AccessContext<DataModel>,
  ) => Promise<AccessDeploymentEntryMirrorResult>;
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
      ancestors?: (item: T) => AccessAuthorizationAncestor[];
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
  listScopeMemberDirectory: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string; cursor?: string; limit?: number },
  ) => Promise<ScopeMemberDirectoryPage>;
  getScopeMemberDirectoryEntry: (
    ctx: AccessContext<DataModel>,
    args: {
      scopeId?: string;
      principalId?: string;
      herculesAuthUserId?: string;
    },
  ) => Promise<ScopeMemberDirectoryEntry | null>;
  listScopeRoles: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<ScopeRoleSummary[]>;
  listScopePermissions: (
    ctx: AccessContext<DataModel>,
    args?: { scopeId?: string },
  ) => Promise<ScopePermissionSummary[]>;
  // "Who has a DIRECT grant on this resource" for an in-app membership panel.
  // DIRECT grants only (excludes scope-wide role/wildcard and parent-inherited
  // access). Self-gates resource-aware on `permission` against this resource, so
  // a per-resource manager (not only a scope admin) can list it; returns [] when
  // the caller is not allowed. `permission`'s resourceType should match
  // `resourceType`.
  listDirectSubjectsForResource: (
    ctx: AccessContext<DataModel>,
    args: {
      scopeId?: string;
      resourceType: string;
      resourceId: string;
      permission: string;
    },
  ) => Promise<DirectResourceSubject[]>;
};

export type PermissionCheckArgs =
  | string
  | {
      scopeId?: string;
      permission: string;
      resource?: AccessResourceRef;
      ancestors?: AccessAuthorizationAncestor[];
    };

export type AnyPermissionCheckArgs =
  | string[]
  | {
      scopeId?: string;
      permissions: string[];
      resource?: AccessResourceRef;
      ancestors?: AccessAuthorizationAncestor[];
    };

export type EffectivePermissionsArgs = {
  scopeId?: string;
  resource?: AccessResourceRef;
  ancestors?: AccessAuthorizationAncestor[];
};

type ConvexDefinitionObject<Ctx> = {
  args?: GenericValidator | PropertyValidators | void;
  returns?: GenericValidator | PropertyValidators | void;
  handler: (ctx: Ctx, ...args: never[]) => unknown;
};

type BuilderCaller = (definition: unknown) => unknown;

/**
 * Wires Hercules managed Access Control into a Convex app. Call once in
 * `convex/access.ts`, passing the generated `query`/`mutation`/`action`
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
 * - `getCurrentHerculesAuthUserId`: the verified OIDC subject for linking
 *   app-owned domain rows. Do not parse `tokenIdentifier`.
 * - `listMyMemberships`/`listMyRoles`: the caller's own scopes/roles.
 * - `listScopeMembers`/`listScopeRoles`/`listScopePermissions`: complete
 *   mirrored admin reads for an in-app management screen. Each self-gates on
 *   the matching `system.*:read` permission and returns `[]` when the caller
 *   lacks it. Use `createAccessManagementActions().listGrantableRoles`
 *   instead when choosing a role for a write at an exact target.
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
    checkPermissions: makeCheckPermissions(component),
    getCurrentHerculesAuthUserId,
    getDeploymentEntryStatus: makeGetDeploymentEntryStatus(component),
    filterAuthorizedResources: makeFilterAuthorizedResources(component),
    listMyMemberships: makeListMyMemberships(component),
    listMyRoles: makeListMyRoles(component),
    listScopeMembers: makeListScopeMembers(component),
    listScopeMemberDirectory: makeListScopeMemberDirectory(component),
    getScopeMemberDirectoryEntry: makeGetScopeMemberDirectoryEntry(component),
    listScopeRoles: makeListScopeRoles(component),
    listScopePermissions: makeListScopePermissions(component),
    listDirectSubjectsForResource: makeListDirectSubjectsForResource(component),
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

// The resourceType `scopeFromResource` emits. An extractor only sees the table
// row, not the permission catalog, so it cannot know the canonical resource
// type the checked permission uses (e.g. `app.project` for
// `app.project:archive`). It emits this sentinel instead, and the component's
// authorize query substitutes the requested permission's canonical catalog
// resourceType (resolved by catalog lookup). Resource grants are pinned to that
// same canonical type on the control plane, so the two match by construction.
// Mirrored in component/checks.ts (like DEFAULT_SCOPE_SENTINEL above).
export const PERMISSION_RESOURCE_TYPE_SENTINEL = "__hercules_permission_resource_type__";

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
 * the row named by `argKey`, returns the row's scope plus the resource id,
 * and lets `authorize` apply resource-level grants on top of the scope check.
 * Use for any read/update/delete that receives an org-owned row id.
 *
 * Params:
 * - `tableName`: the row's table (used in error messages only).
 * - `argKey`: the field on `args` holding the row id.
 * - `options.scopeField`: column carrying the org scope id (default
 *   `"orgScopeId"`).
 *
 * Resource type: the emitted `resourceType` defers to the checked permission's
 * canonical catalog resource type (e.g. `app.project` for
 * `app.project:archive`), which is also the type resource grants are pinned
 * to, so grants on the row always match the guarded permission.
 *
 * Hierarchy: pass `options.authorizeAgainst` to declare ordered parent
 * resources. The target and ancestors are evaluated atomically with the same
 * requested permission, so any applicable deny wins. The app owns these
 * relationships; the chain is bounded to ten ancestors.
 */
export function scopeFromResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    scopeField?: string;
    authorizeAgainst?: (row: Record<string, unknown>) => AccessAuthorizationAncestor[];
  } = {},
) {
  const scopeField = options.scopeField ?? "orgScopeId";
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    scopeId: string;
    resourceType: string;
    resourceId: string;
    ancestors?: Array<{ resourceType: string; resourceId: string }>;
  }> => {
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
    const ancestors = normalizeAncestors(
      options.authorizeAgainst?.(row as Record<string, unknown>),
      `scopeFromResource("${tableName}", "${argKey}")`,
    );
    return {
      scopeId,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: String(id),
      ...(ancestors ? { ancestors } : {}),
    };
  };
}

/**
 * Resolves a specific resource in the default app scope without requiring a
 * scope id column on the row. Use this for single-scope apps that still need
 * resource grants, denies, or per-resource UI checks.
 *
 * The row is loaded from `args[argKey]`, so authorization and mutation stay
 * bound to the same resource. Pass `authorizeAgainst` for trusted parent
 * resources exactly as with {@link scopeFromResource}.
 */
export function scopeFromDefaultResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    authorizeAgainst?: (row: Record<string, unknown>) => AccessAuthorizationAncestor[];
  } = {},
) {
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    scopeId: string;
    resourceType: string;
    resourceId: string;
    ancestors?: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromDefaultResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `scopeFromDefaultResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const ancestors = normalizeAncestors(
      options.authorizeAgainst?.(row as Record<string, unknown>),
      `scopeFromDefaultResource("${tableName}", "${argKey}")`,
    );
    return {
      scopeId: DEFAULT_SCOPE_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: String(id),
      ...(ancestors ? { ancestors } : {}),
    };
  };
}

/**
 * Resolves child-creation authorization from an existing parent row. The
 * requested child permission stays unchanged; the parent is supplied as an
 * explicit ancestor and only descendant-enabled bindings apply through it.
 */
export function scopeFromParentResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    scopeField?: string;
    parentResourceType: string;
    authorizeAgainst?: (row: Record<string, unknown>) => AccessAuthorizationAncestor[];
  },
) {
  const scopeField = options.scopeField ?? "orgScopeId";
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    scopeId: string;
    resourceType: string;
    ancestors: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromParentResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `scopeFromParentResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const scopeId = (row as Record<string, unknown>)[scopeField];
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw new ConvexError({
        code: "INVALID_RESOURCE_SCOPE",
        message: `scopeFromParentResource("${tableName}", "${argKey}"): resource is missing "${scopeField}"`,
      });
    }
    const ancestors = normalizeAncestors(
      [
        { type: options.parentResourceType, id: String(id) },
        ...(options.authorizeAgainst?.(row as Record<string, unknown>) ?? []),
      ],
      `scopeFromParentResource("${tableName}", "${argKey}")`,
    );
    return {
      scopeId,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: ancestors!,
    };
  };
}

/**
 * Resolves child creation against a parent resource in the default app scope.
 * The parent row is loaded from `args[argKey]`; no scope id field is required
 * on the parent or child tables.
 */
export function scopeFromDefaultParentResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    parentResourceType: string;
    authorizeAgainst?: (row: Record<string, unknown>) => AccessAuthorizationAncestor[];
  },
) {
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    scopeId: string;
    resourceType: string;
    ancestors: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `scopeFromDefaultParentResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `scopeFromDefaultParentResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const ancestors = normalizeAncestors(
      [
        { type: options.parentResourceType, id: String(id) },
        ...(options.authorizeAgainst?.(row as Record<string, unknown>) ?? []),
      ],
      `scopeFromDefaultParentResource("${tableName}", "${argKey}")`,
    );
    return {
      scopeId: DEFAULT_SCOPE_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: ancestors!,
    };
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

type AccessConfig = {
  permission?: string;
  scope?: ExtractScope<AuthorizationCtx, unknown>;
};

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

function ancestorArgs(ancestors?: Array<{ resourceType: string; resourceId: string }>) {
  return ancestors ? { ancestors } : {};
}

function normalizeAncestors(
  ancestors: AccessAuthorizationAncestor[] | undefined,
  source = "authorization check",
): Array<{ resourceType: string; resourceId: string }> | undefined {
  if (!ancestors || ancestors.length === 0) return undefined;
  if (ancestors.length > MAX_AUTHORIZE_CHAIN) {
    throw new ConvexError({
      code: "INVALID_SCOPE_ARG",
      message: `${source}: expected at most ${MAX_AUTHORIZE_CHAIN} ancestors`,
    });
  }
  return ancestors.map((ancestor) => {
    if (!ancestor.type || !ancestor.id) {
      throw new ConvexError({
        code: "INVALID_SCOPE_ARG",
        message: `${source}: ancestors require non-empty type and id`,
      });
    }
    return { resourceType: ancestor.type, resourceId: ancestor.id };
  });
}

async function getTokenIdentifier(ctx: AccessContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? undefined;
}

async function getCurrentHerculesAuthUserId(ctx: AccessContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.subject ?? undefined;
}

function normalizePermissionCheckArgs(args: PermissionCheckArgs) {
  if (typeof args === "string") {
    return {
      scopeId: DEFAULT_SCOPE_SENTINEL,
      permission: args,
      resource: undefined,
      ancestors: undefined,
    };
  }
  return {
    scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    permission: args.permission,
    resource: args.resource,
    ancestors: normalizeAncestors(args.ancestors),
  };
}

function normalizeAnyPermissionCheckArgs(args: AnyPermissionCheckArgs) {
  if (Array.isArray(args)) {
    return {
      scopeId: DEFAULT_SCOPE_SENTINEL,
      permissions: args,
      resource: undefined,
      ancestors: undefined,
    };
  }
  return {
    scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    permissions: args.permissions,
    resource: args.resource,
    ancestors: args.ancestors,
  };
}

function normalizeEffectivePermissionsArgs(args: EffectivePermissionsArgs | undefined) {
  return {
    scopeId: args?.scopeId ?? DEFAULT_SCOPE_SENTINEL,
    resource: args?.resource,
    ancestors: normalizeAncestors(args?.ancestors),
  };
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
      ...ancestorArgs(normalized.ancestors),
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
      ...ancestorArgs(normalized.ancestors),
    });
    return result.permissions;
  };
}

function makeCheckPermissions(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    checks: Array<Exclude<PermissionCheckArgs, string>>,
  ): Promise<AuthorizationDecision[]> => {
    if (checks.length > 50) {
      throw new ConvexError({
        code: "INVALID_PERMISSION_CHECKS",
        message: "checkPermissions accepts at most 50 checks",
      });
    }
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) {
      return checks.map(() => ({
        allowed: false,
        reasonCode: "missing_identity",
        effectiveRoleIds: [],
      }));
    }

    return await ctx.runQuery(component.checks.authorizeMany, {
      tokenIdentifier,
      checks: checks.map((check) => {
        const normalized = normalizePermissionCheckArgs(check);
        return {
          scopeId: normalized.scopeId,
          permission: normalized.permission,
          ...resourceArgs(normalized.resource),
          ...ancestorArgs(normalized.ancestors),
        };
      }),
    });
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
      ancestors?: (item: T) => AccessAuthorizationAncestor[];
    },
  ): Promise<T[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];
    const scopeId = args.scopeId ?? DEFAULT_SCOPE_SENTINEL;

    const allowed: T[] = [];
    for (const item of args.resources) {
      const ref = args.resource(item);
      const ancestors = normalizeAncestors(args.ancestors?.(item), "filterAuthorizedResources");
      const decision = await ctx.runQuery(component.checks.authorize, {
        tokenIdentifier,
        scopeId,
        permission: args.permission,
        resourceType: ref.type,
        resourceId: ref.id,
        ...ancestorArgs(ancestors),
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

    return await ctx.runQuery(component.queries.listMyMemberships, {
      tokenIdentifier,
    });
  };
}

function makeGetDeploymentEntryStatus(component: AccessControlComponent) {
  return async (ctx: AccessContext): Promise<AccessDeploymentEntryMirrorResult> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) {
      return { kind: "fallback", reason: "identity_missing" };
    }

    return await ctx.runQuery(component.queries.getDeploymentEntryStatus, {
      tokenIdentifier,
    });
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

function makeListScopeMemberDirectory(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: { scopeId?: string; cursor?: string; limit?: number } = {},
  ): Promise<ScopeMemberDirectoryPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { members: [] };

    const result = await ctx.runQuery(component.queries.listScopeMemberDirectory, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      members: result.members,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeGetScopeMemberDirectoryEntry(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: {
      scopeId?: string;
      principalId?: string;
      herculesAuthUserId?: string;
    },
  ): Promise<ScopeMemberDirectoryEntry | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    return await ctx.runQuery(component.queries.getScopeMemberDirectoryEntry, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
      principalId: args.principalId,
      herculesAuthUserId: args.herculesAuthUserId,
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

function makeListDirectSubjectsForResource(component: AccessControlComponent) {
  return async (
    ctx: AccessContext,
    args: {
      scopeId?: string;
      resourceType: string;
      resourceId: string;
      permission: string;
    },
  ): Promise<DirectResourceSubject[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listDirectSubjectsForResource, {
      tokenIdentifier,
      scopeId: args.scopeId ?? DEFAULT_SCOPE_SENTINEL,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      permission: args.permission,
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
  let ancestors: Array<{ resourceType: string; resourceId: string }> | undefined;
  if (mode === "permission") {
    try {
      const extracted = await (access?.scope ?? defaultScope)(ctx, callerArgs);
      if (typeof extracted === "string") {
        scopeId = extracted;
      } else {
        scopeId = extracted.scopeId;
        resourceType = extracted.resourceType;
        resourceId = extracted.resourceId;
        ancestors = extracted.ancestors;
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
    ...ancestorArgs(ancestors),
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
