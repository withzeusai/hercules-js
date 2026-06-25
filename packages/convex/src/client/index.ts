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
export { classifyIamError } from "./iam-errors.js";
export type { IamAdmissionStatus, IamErrorClassification } from "./iam-errors.js";

type IamMode = "authenticated" | "permission";

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
  tenantId?: string;
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

type ListMyTenantsArgs = { tokenIdentifier?: string; cursor?: string; limit?: number };
type ListMyActiveTenantsArgs = ListMyTenantsArgs & {
  kind?: TenantKind;
};
type GetTargetTenantSyncStatusArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  sourceVersion: number;
};
type GetTenantAccessStatusArgs = { tokenIdentifier?: string };
type ListMyRolesArgs = { tokenIdentifier?: string; tenantId: string };
type GetEffectivePermissionsArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: Array<{ resourceType: string; resourceId: string }>;
};

type ListTenantArgs = { tokenIdentifier?: string; tenantId: string };
type ListTenantPageArgs = ListTenantArgs & {
  cursor?: string;
  limit?: number;
};
type ListTenantUserDirectoryArgs = ListTenantArgs & {
  cursor?: string;
  limit?: number;
};
type ListTenantMemberPickerUsersArgs = ListTenantArgs & {
  permission: string;
  resourceType?: string;
  resourceId?: string;
  ancestors?: Array<{ resourceType: string; resourceId: string }>;
  cursor?: string;
  limit?: number;
};
type ListResourceSharingRecipientsArgs = ListTenantArgs & {
  permission: string;
  resourceType: string;
  resourceId: string;
  ancestors?: Array<{ resourceType: string; resourceId: string }>;
  recipientType: "user" | "group";
  cursor?: string;
  limit?: number;
};
type GetTenantUserDirectoryEntryArgs = ListTenantArgs & {
  userId: string;
};
type GetTenantRoleArgs = ListTenantArgs & {
  roleId: string;
};
type ListGroupMembersArgs = ListTenantArgs & {
  groupId: string;
  cursor?: string;
  limit?: number;
};
type ListUserGroupsArgs = ListTenantArgs & {
  userId: string;
  cursor?: string;
  limit?: number;
};

export type RoleSummary = {
  roleId: string;
  roleKey: string;
  roleName: string;
  roleKind: "system" | "custom";
};

export type TenantDirectRoleGrant = RoleSummary & {
  grantId: string;
  type: "role";
  expiresAt: number | null;
};

export type TenantKind = "default" | "custom";

/** One tenant returned by `listMyTenants`. Select the default tenant by `kind`. */
export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  kind: TenantKind;
  roles: RoleSummary[];
  joinedAt: number;
  accessStatus: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  lifecycleStatus: "active" | "archived";
};

export type ActiveTenantSummary = Omit<TenantSummary, "accessStatus" | "lifecycleStatus"> & {
  accessStatus: "active";
  lifecycleStatus: "active";
};

export type TenantSummariesPage = {
  tenants: TenantSummary[];
  nextCursor?: string;
};

export type ActiveTenantSummariesPage = {
  tenants: ActiveTenantSummary[];
  nextCursor?: string;
};

export type TargetTenantSyncStatus =
  | {
      state: "syncing";
      currentSourceVersion?: number;
      targetSourceVersion: number;
    }
  | {
      state: "ready";
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId: string;
      principalId: string;
    }
  | {
      state: "denied";
      reasonCode: string;
      currentSourceVersion: number;
      targetSourceVersion: number;
      tenantId?: string;
      principalId?: string;
    }
  | {
      state: "failed";
      reasonCode: string;
      currentSourceVersion?: number;
      targetSourceVersion: number;
    };

export type TenantDetail = {
  tenantId: string;
  tenantName: string;
  kind: TenantKind;
  lifecycleStatus: "active" | "archived";
  accessMode: "open" | "allowlisted_only" | "invite_only" | "approval_required";
  defaultRoleId: string;
  updatedAt: number;
};

export type IamPrincipalStatus =
  | "active"
  | "blocked"
  | "suspended"
  | "pending_approval"
  | "removed";

export type IamTenantAccessStatusResult =
  | {
      kind: "principal";
      principalId: string;
      status: IamPrincipalStatus;
      stateVersion: number;
    }
  | {
      kind: "fallback";
      reason:
        | "identity_missing"
        | "identity_invalid"
        | "unexpected_issuer"
        | "mirror_not_ready"
        | "default_tenant_missing"
        | "principal_missing";
      stateVersion?: number;
    };

export type EffectivePermissionsResult = {
  allowed: boolean;
  reasonCode: string;
  sourceVersion?: number;
  tenantId?: string;
  principalId?: string;
  effectiveRoleIds: string[];
  // §0b: the principal's resolved wildcard mode. Under the wildcard model
  // `permissions` is a projection over the unbounded catalog (Owner = whole
  // catalog, Admin = catalog minus Owner-only levers), so callers should treat
  // a non-"none" mode as future-inclusive rather than exhaustive.
  wildcard: "none" | "immutable" | "default";
  permissions: string[];
};

export type TenantUser = {
  userId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string;
  roles: RoleSummary[];
  directRoleGrants: TenantDirectRoleGrant[];
};

export type TenantGroup = {
  groupId: string;
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  joinedAt: number;
  memberCount: number;
  name?: string;
  roles: RoleSummary[];
  directRoleGrants: TenantDirectRoleGrant[];
};

export type TenantUsersPage = {
  users: TenantUser[];
  nextCursor?: string;
};

export type TenantGroupsPage = {
  groups: TenantGroup[];
  nextCursor?: string;
};

export type DirectResourceSubjectsPage = {
  subjects: DirectResourceSubject[];
  nextCursor?: string;
};

/** One user in a `listTenantUserDirectory` page. */
export type TenantUserDirectoryEntry = {
  userId: string;
  name: string;
  email: string;
  image?: string;
  roles: RoleSummary[];
};

export type TenantUserDirectoryPage = {
  users: TenantUserDirectoryEntry[];
  nextCursor?: string;
};

export type TenantMemberPickerUser = {
  userId: string;
  name: string;
  email: string;
  image?: string;
};

export type TenantMemberPickerUsersPage = {
  users: TenantMemberPickerUser[];
  nextCursor?: string;
};

export type SharingRecipient =
  | {
      type: "user";
      userId: string;
      name: string;
      email: string;
      image?: string;
    }
  | {
      type: "group";
      groupId: string;
      name?: string;
    };

export type SharingRecipientsPage = {
  recipients: SharingRecipient[];
  nextCursor?: string;
};

/** One catalog role returned by `listTenantRoles`. Use `roleKey` and `roleName` for display only. */
export type TenantRoleSummary = RoleSummary & { shared: boolean };

export type TenantPermissionSummary = {
  permissionId: string;
  key: string;
  resourceType: string;
  action: string;
  classification: "delegable" | "owner_only";
  tenantAssignable: boolean;
};

export type TenantRolePermission = TenantPermissionSummary & {
  effect: "allow" | "deny";
};

export type TenantRoleDetail = TenantRoleSummary & {
  description: string | null;
  basePermissions: TenantRolePermission[];
  tenantOverrides: TenantRolePermission[];
  effectivePermissions: TenantPermissionSummary[];
};

export type DirectResourceRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

export type DirectResourcePermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: number | null;
  appliesTo: "self" | "self_and_descendants";
};

type DirectResourceSubjectBase = {
  status: "active" | "blocked" | "suspended" | "pending_approval" | "removed";
  name?: string;
  email?: string;
  image?: string;
};

export type DirectResourceSubject = DirectResourceSubjectBase &
  ({ type: "user"; userId: string } | { type: "group"; groupId: string }) &
  (
    | { grant: DirectResourceRoleGrant; role: RoleSummary }
    | { grant: DirectResourcePermissionGrant }
  );

export type ResourcePermissionOverrideSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

export type ResourcePermissionOverrideTarget =
  | { type: "all" }
  | { type: "resource"; resourceId: string };

export type ResourcePermissionOverridesResult = {
  tenantId: string;
  subject: ResourcePermissionOverrideSubject;
  resourceType: string;
  target: ResourcePermissionOverrideTarget;
  grants: DirectResourcePermissionGrant[];
};

export type ExplainAccessTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      ancestors?: Array<{ resourceType: string; resourceId: string }>;
    };

export type ExplainAccessGrantSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "role"; roleId: string };

export type ExplainAccessGrantSource = {
  grantId: string;
  grantType: "role" | "permission";
  subject: ExplainAccessGrantSubject;
  roleId?: string;
  permissionId?: string;
  permissionKey?: string;
  effect: "allow" | "deny";
  target: { type: "tenant" } | { type: "resource"; resourceType: string; resourceId?: string };
  appliesTo: "self" | "self_and_descendants";
  expiresAt: number | null;
  inherited: boolean;
};

export type ExplainAccessEntryOrigin =
  | { kind: "role_permission"; roleId: string }
  | {
      kind: "permission_grant";
      grantId: string;
      subject: ExplainAccessGrantSubject;
      inherited: boolean;
    }
  | {
      kind: "resource_role";
      grantId: string;
      roleId: string;
      subject: ExplainAccessGrantSubject;
      inherited: boolean;
    };

export type ExplainAccessResult = {
  tenantId: string;
  userId: string;
  permission: string;
  target: ExplainAccessTarget;
  allowed: boolean;
  reasonCode: string;
  explicitDeny: boolean;
  decisiveReason: string;
  sourceVersion?: number;
  principalId?: string;
  effectiveRoleIds: string[];
  sources: {
    directGrants: ExplainAccessGrantSource[];
    groupMemberships: Array<{
      groupId: string;
      groupName?: string;
      status?: IamPrincipalStatus;
      active: boolean;
    }>;
    roles: Array<{
      roleId: string;
      roleKey: string;
      roleName: string;
      description: string | null;
      wildcard: "none" | "immutable" | "default";
      permissionEffect: "allow" | "deny" | null;
      grantIds: string[];
      viaGroupIds: string[];
    }>;
    roleOverrides: Array<{
      roleId: string;
      permissionId: string;
      permissionKey: string;
      effect: "allow" | "deny";
    }>;
    resourceGrants: ExplainAccessGrantSource[];
    ancestorGrants: ExplainAccessGrantSource[];
    explicitDenies: Array<{
      resourceType: string;
      action: string;
      objectType: "tenant" | "resource";
      objectId?: string;
      source?: ExplainAccessEntryOrigin;
    }>;
    expiredIgnoredGrants: ExplainAccessGrantSource[];
  };
};

type ListDirectSubjectsArgs = {
  tokenIdentifier?: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  cursor?: string;
  limit?: number;
};

type GetResourcePermissionOverridesArgs = ListTenantArgs & {
  subject: ResourcePermissionOverrideSubject;
  resourceType: string;
  target: ResourcePermissionOverrideTarget;
};

type ExplainAccessArgs = ListTenantArgs & {
  userId: string;
  permission: string;
  target: ExplainAccessTarget;
};

export type IamContext<DataModel extends GenericDataModel = any> =
  | Pick<GenericQueryCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericMutationCtx<DataModel>, "auth" | "runQuery">
  | Pick<GenericActionCtx<DataModel>, "auth" | "runQuery">;

export type IamResourceRef = { type: string; id?: string };
export type IamAuthorizationAncestor = { type: string; id: string };

export type IamComponent = {
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
    getTenantAccessStatus: FunctionReference<
      "query",
      "public",
      GetTenantAccessStatusArgs,
      IamTenantAccessStatusResult
    >;
    listMyTenants: FunctionReference<
      "query",
      "public",
      ListMyTenantsArgs,
      { tenants: TenantSummary[]; cursor?: string }
    >;
    listMyActiveTenants: FunctionReference<
      "query",
      "public",
      ListMyActiveTenantsArgs,
      { tenants: ActiveTenantSummary[]; cursor?: string }
    >;
    getTargetTenantSyncStatus: FunctionReference<
      "query",
      "public",
      GetTargetTenantSyncStatusArgs,
      TargetTenantSyncStatus
    >;
    listMyRoles: FunctionReference<"query", "public", ListMyRolesArgs, RoleSummary[]>;
    getEffectivePermissions: FunctionReference<
      "query",
      "public",
      GetEffectivePermissionsArgs,
      EffectivePermissionsResult
    >;
    getTenant: FunctionReference<"query", "public", ListTenantArgs, TenantDetail | null>;
    listTenantUsers: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs,
      { users: TenantUser[]; cursor?: string }
    >;
    listTenantGroups: FunctionReference<
      "query",
      "public",
      ListTenantPageArgs,
      { groups: TenantGroup[]; cursor?: string }
    >;
    listTenantUserDirectory: FunctionReference<
      "query",
      "public",
      ListTenantUserDirectoryArgs,
      { users: TenantUserDirectoryEntry[]; cursor?: string }
    >;
    listTenantMemberPickerUsers: FunctionReference<
      "query",
      "public",
      ListTenantMemberPickerUsersArgs,
      { users: TenantMemberPickerUser[]; cursor?: string }
    >;
    listResourceSharingRecipients: FunctionReference<
      "query",
      "public",
      ListResourceSharingRecipientsArgs,
      { recipients: SharingRecipient[]; cursor?: string }
    >;
    getTenantUserDirectoryEntry: FunctionReference<
      "query",
      "public",
      GetTenantUserDirectoryEntryArgs,
      TenantUserDirectoryEntry | null
    >;
    listGroupMembers: FunctionReference<
      "query",
      "public",
      ListGroupMembersArgs,
      { users: TenantUser[]; cursor?: string }
    >;
    listUserGroups: FunctionReference<
      "query",
      "public",
      ListUserGroupsArgs,
      { groups: TenantGroup[]; cursor?: string }
    >;
    listTenantRoles: FunctionReference<"query", "public", ListTenantArgs, TenantRoleSummary[]>;
    getTenantRole: FunctionReference<"query", "public", GetTenantRoleArgs, TenantRoleDetail | null>;
    listTenantPermissions: FunctionReference<
      "query",
      "public",
      ListTenantArgs,
      TenantPermissionSummary[]
    >;
    getResourcePermissionOverrides: FunctionReference<
      "query",
      "public",
      GetResourcePermissionOverridesArgs,
      ResourcePermissionOverridesResult | null
    >;
    explainAccess: FunctionReference<
      "query",
      "public",
      ExplainAccessArgs,
      ExplainAccessResult | null
    >;
    listDirectSubjectsForResource: FunctionReference<
      "query",
      "public",
      ListDirectSubjectsArgs,
      { subjects: DirectResourceSubject[]; cursor?: string }
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

// A tenant extractor can return either a bare tenant id or a
// richer object that also names a specific resource for DL16 resource
// grant support. tenantFromResource returns the richer shape so the
// authorize call can walk resource-object grants.
export type ExtractedTenant =
  | string
  | {
      tenantId: string;
      resourceType?: string;
      resourceId?: string;
      ancestors?: Array<{ resourceType: string; resourceId: string }>;
    };

export type ExtractTenant<Ctx, Args> = (
  ctx: Ctx,
  args: Args,
) => ExtractedTenant | Promise<ExtractedTenant>;

// Hard cap on resource-hierarchy depth: a request authorizes against the
// resource plus at most this many ancestors. Generous for real nesting
// (folder/file, project/task/comment) while bounding the per-call check count.
const MAX_AUTHORIZE_CHAIN = 10;
const AUTHORIZE_MANY_CHUNK_SIZE = 50;

export type IamQueryBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(query: {
    permission: string;
    tenant?: ExtractTenant<GenericQueryCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredQuery<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type IamMutationBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(mutation: {
    permission: string;
    tenant?: ExtractTenant<GenericMutationCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredMutation<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type IamActionBuilder<DataModel extends GenericDataModel> = {
  <
    ArgsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnsValidator extends PropertyValidators | Validator<unknown, "required", string> | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(action: {
    permission: string;
    tenant?: ExtractTenant<GenericActionCtx<DataModel>, OneOrZeroArgs[0]>;
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (ctx: GenericActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
  }): RegisteredAction<"public", ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;
};

export type IamBuilders<DataModel extends GenericDataModel> = {
  publicQuery: QueryBuilder<DataModel, "public">;
  publicMutation: MutationBuilder<DataModel, "public">;
  publicAction: ActionBuilder<DataModel, "public">;
  authenticatedQuery: QueryBuilder<DataModel, "public">;
  authenticatedMutation: MutationBuilder<DataModel, "public">;
  authenticatedAction: ActionBuilder<DataModel, "public">;
  iamQuery: IamQueryBuilder<DataModel>;
  iamMutation: IamMutationBuilder<DataModel>;
  iamAction: IamActionBuilder<DataModel>;
  hasPermission: (ctx: IamContext<DataModel>, args: PermissionCheckArgs) => Promise<boolean>;
  requirePermission: (ctx: IamContext<DataModel>, args: PermissionCheckArgs) => Promise<void>;
  requireAnyPermission: (ctx: IamContext<DataModel>, args: AnyPermissionCheckArgs) => Promise<void>;
  getEffectivePermissions: (
    ctx: IamContext<DataModel>,
    args?: EffectivePermissionsArgs,
  ) => Promise<string[]>;
  checkPermissions: (
    ctx: IamContext<DataModel>,
    checks: Array<Exclude<PermissionCheckArgs, string>>,
  ) => Promise<AuthorizationDecision[]>;
  /**
   * Return the current user's canonical Hercules Auth id (`sub`) from the
   * verified Convex identity. Use this to link app-owned profile or domain
   * rows to the signed-in user instead of parsing `tokenIdentifier`.
   */
  getCurrentHerculesAuthUserId: (ctx: IamContext<DataModel>) => Promise<string | undefined>;
  getTenantAccessStatus: (ctx: IamContext<DataModel>) => Promise<IamTenantAccessStatusResult>;
  // Filter a page of the APP's own resource rows down to the ones the caller is
  // allowed to access, by running the same per-resource permission check as a
  // real `iamQuery`. Use this for "list my projects" style lists: the app
  // owns and paginates its rows, Hercules never enumerates them. Pass a bounded
  // page, not an entire table (checks are batched via authorizeMany).
  filterAuthorizedResources: <T>(
    ctx: IamContext<DataModel>,
    args: {
      resources: T[];
      permission: string;
      tenantId?: string;
      resource: (item: T) => IamResourceRef;
      ancestors?: (item: T) => IamAuthorizationAncestor[];
    },
  ) => Promise<T[]>;
  listMyTenants: (
    ctx: IamContext<DataModel>,
    args?: { cursor?: string; limit?: number },
  ) => Promise<TenantSummariesPage>;
  listMyActiveTenants: (
    ctx: IamContext<DataModel>,
    args?: { cursor?: string; limit?: number; kind?: TenantKind },
  ) => Promise<ActiveTenantSummariesPage>;
  getTargetTenantSyncStatus: (
    ctx: IamContext<DataModel>,
    args: { tenantId: string; sourceVersion: number },
  ) => Promise<TargetTenantSyncStatus>;
  listMyRoles: (ctx: IamContext<DataModel>, args?: { tenantId?: string }) => Promise<RoleSummary[]>;
  // Tenant-admin reads for an in-app management screen. Each requires the caller
  // to hold the matching read permission (system.access.users:read /
  // system.access.roles:read / system.access.permissions:read) in the tenant;
  // otherwise they resolve to an empty
  // list. Reads come from the local mirror, like every other IAM query.
  getTenant: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string },
  ) => Promise<TenantDetail | null>;
  listTenantUsers: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string; cursor?: string; limit?: number },
  ) => Promise<TenantUsersPage>;
  listTenantGroups: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string; cursor?: string; limit?: number },
  ) => Promise<TenantGroupsPage>;
  listTenantUserDirectory: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string; cursor?: string; limit?: number },
  ) => Promise<TenantUserDirectoryPage>;
  listTenantMemberPickerUsers: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      permission: string;
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
      cursor?: string;
      limit?: number;
    },
  ) => Promise<TenantMemberPickerUsersPage>;
  listResourceSharingRecipients: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      permission: string;
      resourceType: string;
      resourceId: string;
      ancestors?: IamAuthorizationAncestor[];
      recipientType: "user" | "group";
      cursor?: string;
      limit?: number;
    },
  ) => Promise<SharingRecipientsPage>;
  getTenantUserDirectoryEntry: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      userId: string;
    },
  ) => Promise<TenantUserDirectoryEntry | null>;
  listGroupMembers: (
    ctx: IamContext<DataModel>,
    args: { tenantId?: string; groupId: string; cursor?: string; limit?: number },
  ) => Promise<TenantUsersPage>;
  listUserGroups: (
    ctx: IamContext<DataModel>,
    args: { tenantId?: string; userId: string; cursor?: string; limit?: number },
  ) => Promise<TenantGroupsPage>;
  listTenantRoles: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string },
  ) => Promise<TenantRoleSummary[]>;
  getTenantRole: (
    ctx: IamContext<DataModel>,
    args: { tenantId?: string; roleId: string },
  ) => Promise<TenantRoleDetail | null>;
  listTenantPermissions: (
    ctx: IamContext<DataModel>,
    args?: { tenantId?: string },
  ) => Promise<TenantPermissionSummary[]>;
  getResourcePermissionOverrides: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      subject: ResourcePermissionOverrideSubject;
      resourceType: string;
      target: ResourcePermissionOverrideTarget;
    },
  ) => Promise<ResourcePermissionOverridesResult | null>;
  explainAccess: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      userId: string;
      permission: string;
      target: ExplainAccessTarget;
    },
  ) => Promise<ExplainAccessResult | null>;
  // "Who has a DIRECT grant on this resource" for an in-app membership panel.
  // DIRECT grants only (excludes tenant-wide role/wildcard and parent-inherited
  // access). Requires system.access.grants:read in the tenant and returns an
  // empty page when the caller is not allowed.
  listDirectSubjectsForResource: (
    ctx: IamContext<DataModel>,
    args: {
      tenantId?: string;
      resourceType: string;
      resourceId: string;
      cursor?: string;
      limit?: number;
    },
  ) => Promise<DirectResourceSubjectsPage>;
};

export type PermissionCheckArgs =
  | string
  | {
      tenantId?: string;
      permission: string;
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
    };

export type AnyPermissionCheckArgs =
  | string[]
  | {
      tenantId?: string;
      permissions: string[];
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
    };

export type EffectivePermissionsArgs = {
  tenantId?: string;
  resource?: IamResourceRef;
  ancestors?: IamAuthorizationAncestor[];
};

type ConvexDefinitionObject<Ctx> = {
  args?: GenericValidator | PropertyValidators | void;
  returns?: GenericValidator | PropertyValidators | void;
  handler: (ctx: Ctx, ...args: never[]) => unknown;
};

type BuilderCaller = (definition: unknown) => unknown;

/**
 * Wires Hercules managed IAM into a Convex app. Call once in
 * `convex/iam.ts`, passing the generated `query`/`mutation`/`action`
 * builders and `components`, then re-export the returned builders.
 *
 * Returned builders:
 * - `publicQuery`/`publicMutation`/`publicAction`: no auth.
 * - `authenticatedQuery`/`...Mutation`/`...Action`: require sign-in only.
 * - `iamQuery`/`iamMutation`/`iamAction`: enforce a permission in a
 *   tenant. Pass `{ permission, tenant }`; resolve `tenant` with
 *   `tenantFromArg` or `tenantFromResource`.
 * - `hasPermission`/`requirePermission`/`requireAnyPermission`/
 *   `getEffectivePermissions`: in-handler checks. `getEffectivePermissions`
 *   and `hasPermission` accept an optional `{ resource }` ref for per-resource
 *   (e.g. per-project) checks.
 * - `getCurrentHerculesAuthUserId`: the verified OIDC subject for linking
 *   app-owned domain rows. Do not parse `tokenIdentifier`.
 * - `listMyTenants`/`listMyRoles`: the caller's own tenants and roles.
 * - `listTenantUsers`/`listTenantGroups`/`listTenantRoles`/
 *   `listTenantPermissions`: complete
 *   mirrored admin reads for an in-app management screen. Each self-gates on
 *   the matching `system.*:read` permission and returns `[]` when the caller
 *   lacks it. Do not use mirror reads as write authorization; write paths
 *   should call generated IAM SDK methods that enforce grantability.
 *
 * Reads resolve against the app's local IAM mirror, which lags the
 * control plane by a short projection-sync window after any change.
 */
export function createIam<DataModel extends GenericDataModel>(
  options: CreateIamOptions<DataModel>,
): IamBuilders<DataModel> {
  const component = resolveComponent(options);

  return {
    publicQuery: options.query,
    publicMutation: options.mutation,
    publicAction: options.action,
    authenticatedQuery: makeAuthenticatedBuilder(options.query, component),
    authenticatedMutation: makeAuthenticatedBuilder(options.mutation, component),
    authenticatedAction: makeAuthenticatedBuilder(options.action, component),
    iamQuery: makeIamBuilder(options.query, component) as IamQueryBuilder<DataModel>,
    iamMutation: makeIamBuilder(options.mutation, component) as IamMutationBuilder<DataModel>,
    iamAction: makeIamBuilder(options.action, component) as IamActionBuilder<DataModel>,
    hasPermission: makeHasPermission(component),
    requirePermission: makeRequirePermission(component),
    requireAnyPermission: makeRequireAnyPermission(component),
    getEffectivePermissions: makeGetEffectivePermissions(component),
    checkPermissions: makeCheckPermissions(component),
    getCurrentHerculesAuthUserId,
    getTenantAccessStatus: makeGetTenantAccessStatus(component),
    filterAuthorizedResources: makeFilterAuthorizedResources(component),
    listMyTenants: makeListMyTenants(component),
    listMyActiveTenants: makeListMyActiveTenants(component),
    getTargetTenantSyncStatus: makeGetTargetTenantSyncStatus(component),
    listMyRoles: makeListMyRoles(component),
    getTenant: makeGetTenant(component),
    listTenantUsers: makeListTenantUsers(component),
    listTenantGroups: makeListTenantGroups(component),
    listTenantUserDirectory: makeListTenantUserDirectory(component),
    listTenantMemberPickerUsers: makeListTenantMemberPickerUsers(component),
    listResourceSharingRecipients: makeListResourceSharingRecipients(component),
    getTenantUserDirectoryEntry: makeGetTenantUserDirectoryEntry(component),
    listGroupMembers: makeListGroupMembers(component),
    listUserGroups: makeListUserGroups(component),
    listTenantRoles: makeListTenantRoles(component),
    getTenantRole: makeGetTenantRole(component),
    listTenantPermissions: makeListTenantPermissions(component),
    getResourcePermissionOverrides: makeGetResourcePermissionOverrides(component),
    explainAccess: makeExplainAccess(component),
    listDirectSubjectsForResource: makeListDirectSubjectsForResource(component),
  };
}

// Single-tenant apps that don't pass a tenant arg resolve to the app's
// default tenant. The component query looks up the persisted default scope
// row from the mirror, so this helper just returns a sentinel string and
// authorize resolves it. The sentinel means "use the default tenant"
// inside the authorize implementation (component reads the unique row with
// kind="default").
export const DEFAULT_TENANT_SENTINEL = "__hercules_default_tenant__";

export const defaultTenant: ExtractTenant<unknown, unknown> = () => DEFAULT_TENANT_SENTINEL;

// The resourceType `tenantFromResource` emits. An extractor only sees the table
// row, not the permission catalog, so it cannot know the canonical resource
// type the checked permission uses (e.g. `app.project` for
// `app.project:archive`). It emits this sentinel instead, and the component's
// authorize query substitutes the requested permission's canonical catalog
// resourceType (resolved by catalog lookup). Resource grants are pinned to that
// same canonical type on the control plane, so the two match by construction.
// Mirrored in component/checks.ts (like DEFAULT_TENANT_SENTINEL above).
export const PERMISSION_RESOURCE_TYPE_SENTINEL = "__hercules_permission_resource_type__";

/**
 * Resolves the tenant for an `iam*` builder from a string arg the caller
 * passes. Use for list/create handlers where the frontend already knows the
 * tenant. Throws if the arg is missing or empty.
 *
 * For operations that receive a tenant-owned row id, use
 * `tenantFromResource` so the tenant is read from the row.
 */
export function tenantFromArg<K extends string>(argKey: K) {
  return (_ctx: unknown, args: Record<string, unknown>): string => {
    const value = args?.[argKey];
    if (typeof value !== "string" || value.length === 0) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `tenantFromArg("${argKey}"): expected non-empty string on args.${argKey}`,
      });
    }
    return value;
  };
}

type DbResourceCtx = { db: { get(id: unknown): Promise<unknown> } };

/**
 * Resolves the tenant from a referenced row for an `iam*` builder.
 *
 * Params:
 * - `tableName`: the row's table (used in error messages only).
 * - `argKey`: the field on `args` holding the row id.
 * - `options.tenantField`: column carrying the tenant id (default
 *   `"tenantId"`).
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
export function tenantFromResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    tenantField?: string;
    authorizeAgainst?: (row: Record<string, unknown>) => IamAuthorizationAncestor[];
  } = {},
) {
  const tenantField = options.tenantField ?? "tenantId";
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    tenantId: string;
    resourceType: string;
    resourceId: string;
    ancestors?: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `tenantFromResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `tenantFromResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const tenantId = (row as Record<string, unknown>)[tenantField];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new ConvexError({
        code: "INVALID_RESOURCE_TENANT",
        message: `tenantFromResource("${tableName}", "${argKey}"): resource is missing "${tenantField}"`,
      });
    }
    const ancestors = normalizeAncestors(
      options.authorizeAgainst?.(row as Record<string, unknown>),
      `tenantFromResource("${tableName}", "${argKey}")`,
    );
    return {
      tenantId,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      resourceId: String(id),
      ...(ancestors ? { ancestors } : {}),
    };
  };
}

/**
 * Resolves a specific resource in the default app tenant without requiring a
 * tenant id column on the row. Use this for single-tenant apps that need
 * resource grants, denies, or per-resource UI checks.
 *
 * The row is loaded from `args[argKey]`, so authorization and mutation stay
 * bound to the same resource. Pass `authorizeAgainst` for trusted parent
 * resources exactly as with {@link tenantFromResource}.
 */
export function tenantFromDefaultResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    authorizeAgainst?: (row: Record<string, unknown>) => IamAuthorizationAncestor[];
  } = {},
) {
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    tenantId: string;
    resourceType: string;
    resourceId: string;
    ancestors?: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `tenantFromDefaultResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `tenantFromDefaultResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const ancestors = normalizeAncestors(
      options.authorizeAgainst?.(row as Record<string, unknown>),
      `tenantFromDefaultResource("${tableName}", "${argKey}")`,
    );
    return {
      tenantId: DEFAULT_TENANT_SENTINEL,
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
export function tenantFromParentResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    tenantField?: string;
    parentResourceType: string;
    authorizeAgainst?: (row: Record<string, unknown>) => IamAuthorizationAncestor[];
  },
) {
  const tenantField = options.tenantField ?? "tenantId";
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    tenantId: string;
    resourceType: string;
    ancestors: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `tenantFromParentResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `tenantFromParentResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const tenantId = (row as Record<string, unknown>)[tenantField];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new ConvexError({
        code: "INVALID_RESOURCE_TENANT",
        message: `tenantFromParentResource("${tableName}", "${argKey}"): resource is missing "${tenantField}"`,
      });
    }
    const ancestors = normalizeAncestors(
      [
        { type: options.parentResourceType, id: String(id) },
        ...(options.authorizeAgainst?.(row as Record<string, unknown>) ?? []),
      ],
      `tenantFromParentResource("${tableName}", "${argKey}")`,
    );
    return {
      tenantId,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: ancestors!,
    };
  };
}

/**
 * Resolves child creation against a parent resource in the default app tenant.
 * The parent row is loaded from `args[argKey]`; no tenant id field is required
 * on the parent or child tables.
 */
export function tenantFromDefaultParentResource<T extends string, K extends string>(
  tableName: T,
  argKey: K,
  options: {
    parentResourceType: string;
    authorizeAgainst?: (row: Record<string, unknown>) => IamAuthorizationAncestor[];
  },
) {
  return async (
    ctx: DbResourceCtx,
    args: Record<string, unknown>,
  ): Promise<{
    tenantId: string;
    resourceType: string;
    ancestors: Array<{ resourceType: string; resourceId: string }>;
  }> => {
    const id = args?.[argKey];
    if (id == null) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `tenantFromDefaultParentResource("${tableName}", "${argKey}"): args.${argKey} is missing`,
      });
    }
    const row = await ctx.db.get(id);
    if (!row || typeof row !== "object") {
      throw new ConvexError({
        code: "RESOURCE_NOT_FOUND",
        message: `tenantFromDefaultParentResource("${tableName}", "${argKey}"): resource not found`,
      });
    }
    const ancestors = normalizeAncestors(
      [
        { type: options.parentResourceType, id: String(id) },
        ...(options.authorizeAgainst?.(row as Record<string, unknown>) ?? []),
      ],
      `tenantFromDefaultParentResource("${tableName}", "${argKey}")`,
    );
    return {
      tenantId: DEFAULT_TENANT_SENTINEL,
      resourceType: PERMISSION_RESOURCE_TYPE_SENTINEL,
      ancestors: ancestors!,
    };
  };
}

function resolveComponent<DataModel extends GenericDataModel>(
  options: CreateIamOptions<DataModel>,
): IamComponent {
  if (options.component) {
    return options.component;
  }

  const componentName = options.componentName ?? "hercules";
  const component = options.components?.[componentName];

  if (!component) {
    throw new Error(
      "Missing Hercules IAM component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component as IamComponent;
}

function makeAuthenticatedBuilder<TBuilder>(builder: TBuilder, component: IamComponent): TBuilder {
  return ((definition: unknown) => {
    return (builder as BuilderCaller)(wrapDefinition(definition, component, "authenticated"));
  }) as TBuilder;
}

function makeIamBuilder<TBuilder>(builder: TBuilder, component: IamComponent): TBuilder {
  return ((definition: unknown) => {
    if (typeof definition !== "object" || definition === null || !("handler" in definition)) {
      throw new Error("iam* builders require an object definition with a permission.");
    }

    const iamDefinition = definition as ConvexDefinitionObject<AuthorizationCtx> & {
      permission?: unknown;
      tenant?: unknown;
    };
    if (typeof iamDefinition.permission !== "string" || iamDefinition.permission.length === 0) {
      throw new Error("iam* builders require a non-empty permission.");
    }
    if (iamDefinition.tenant !== undefined && typeof iamDefinition.tenant !== "function") {
      throw new Error("iam* builders require tenant to be a function.");
    }
    const { permission, tenant, ...convexDefinition } = iamDefinition;
    const tenantExtractor = (tenant ?? defaultTenant) as ExtractTenant<AuthorizationCtx, unknown>;
    return (builder as BuilderCaller)(
      wrapDefinition(convexDefinition, component, "permission", {
        permission,
        tenant: tenantExtractor,
      }),
    );
  }) as TBuilder;
}

type IamConfig = {
  permission?: string;
  tenant?: ExtractTenant<AuthorizationCtx, unknown>;
};

function wrapDefinition(
  definition: unknown,
  component: IamComponent,
  mode: IamMode,
  iam?: IamConfig,
) {
  if (typeof definition === "function") {
    return async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, iam, args[0]);
      return (definition as (ctx: AuthorizationCtx, ...rest: never[]) => unknown)(ctx, ...args);
    };
  }

  const objectDefinition = definition as ConvexDefinitionObject<AuthorizationCtx>;
  return {
    ...objectDefinition,
    handler: async (ctx: AuthorizationCtx, ...args: never[]) => {
      await ensureAuthorized(ctx, component, mode, iam, args[0]);
      return objectDefinition.handler(ctx, ...args);
    },
  };
}

type AuthorizationCtx =
  | GenericQueryCtx<GenericDataModel>
  | GenericMutationCtx<GenericDataModel>
  | GenericActionCtx<GenericDataModel>;

function resourceArgs(resource?: IamResourceRef) {
  return { resourceType: resource?.type, resourceId: resource?.id };
}

function ancestorArgs(ancestors?: Array<{ resourceType: string; resourceId: string }>) {
  return ancestors ? { ancestors } : {};
}

function normalizeAncestors(
  ancestors: IamAuthorizationAncestor[] | undefined,
  source = "authorization check",
): Array<{ resourceType: string; resourceId: string }> | undefined {
  if (!ancestors || ancestors.length === 0) return undefined;
  if (ancestors.length > MAX_AUTHORIZE_CHAIN) {
    throw new ConvexError({
      code: "INVALID_TENANT_ARG",
      message: `${source}: expected at most ${MAX_AUTHORIZE_CHAIN} ancestors`,
    });
  }
  return ancestors.map((ancestor) => {
    if (!ancestor.type || !ancestor.id) {
      throw new ConvexError({
        code: "INVALID_TENANT_ARG",
        message: `${source}: ancestors require non-empty type and id`,
      });
    }
    return { resourceType: ancestor.type, resourceId: ancestor.id };
  });
}

async function getTokenIdentifier(ctx: IamContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? undefined;
}

async function getCurrentHerculesAuthUserId(ctx: IamContext): Promise<string | undefined> {
  return (await ctx.auth.getUserIdentity())?.subject ?? undefined;
}

function normalizePermissionCheckArgs(args: PermissionCheckArgs) {
  if (typeof args === "string") {
    return {
      tenantId: DEFAULT_TENANT_SENTINEL,
      permission: args,
      resource: undefined,
      ancestors: undefined,
    };
  }
  return {
    tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    permission: args.permission,
    resource: args.resource,
    ancestors: normalizeAncestors(args.ancestors),
  };
}

function normalizeAnyPermissionCheckArgs(args: AnyPermissionCheckArgs) {
  if (Array.isArray(args)) {
    return {
      tenantId: DEFAULT_TENANT_SENTINEL,
      permissions: args,
      resource: undefined,
      ancestors: undefined,
    };
  }
  return {
    tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    permissions: args.permissions,
    resource: args.resource,
    ancestors: args.ancestors,
  };
}

function normalizeEffectivePermissionsArgs(args: EffectivePermissionsArgs | undefined) {
  return {
    tenantId: args?.tenantId ?? DEFAULT_TENANT_SENTINEL,
    resource: args?.resource,
    ancestors: normalizeAncestors(args?.ancestors),
  };
}

function makeHasPermission(component: IamComponent) {
  return async (ctx: IamContext, args: PermissionCheckArgs): Promise<boolean> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return false;
    const normalized = normalizePermissionCheckArgs(args);

    const decision = await ctx.runQuery(component.checks.authorize, {
      tokenIdentifier,
      tenantId: normalized.tenantId,
      permission: normalized.permission,
      ...resourceArgs(normalized.resource),
      ...ancestorArgs(normalized.ancestors),
    });
    return decision.allowed;
  };
}

function makeRequirePermission(component: IamComponent) {
  const hasPermission = makeHasPermission(component);
  return async (ctx: IamContext, args: PermissionCheckArgs): Promise<void> => {
    if (await hasPermission(ctx, args)) return;
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeRequireAnyPermission(component: IamComponent) {
  const hasPermission = makeHasPermission(component);
  return async (ctx: IamContext, args: AnyPermissionCheckArgs): Promise<void> => {
    const normalized = normalizeAnyPermissionCheckArgs(args);
    for (const permission of normalized.permissions) {
      if (await hasPermission(ctx, { ...normalized, permission })) return;
    }
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Access denied" });
  };
}

function makeGetEffectivePermissions(component: IamComponent) {
  return async (ctx: IamContext, args?: EffectivePermissionsArgs): Promise<string[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];
    const normalized = normalizeEffectivePermissionsArgs(args);

    const result = await ctx.runQuery(component.queries.getEffectivePermissions, {
      tokenIdentifier,
      tenantId: normalized.tenantId,
      ...resourceArgs(normalized.resource),
      ...ancestorArgs(normalized.ancestors),
    });
    return result.permissions;
  };
}

function makeCheckPermissions(component: IamComponent) {
  return async (
    ctx: IamContext,
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
          tenantId: normalized.tenantId,
          permission: normalized.permission,
          ...resourceArgs(normalized.resource),
          ...ancestorArgs(normalized.ancestors),
        };
      }),
    });
  };
}

function makeFilterAuthorizedResources(component: IamComponent) {
  return async <T>(
    ctx: IamContext,
    args: {
      resources: T[];
      permission: string;
      tenantId?: string;
      resource: (item: T) => IamResourceRef;
      ancestors?: (item: T) => IamAuthorizationAncestor[];
    },
  ): Promise<T[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];
    const tenantId = args.tenantId ?? DEFAULT_TENANT_SENTINEL;

    const checks = args.resources.map((item) => {
      const ref = args.resource(item);
      const ancestors = normalizeAncestors(args.ancestors?.(item), "filterAuthorizedResources");
      return {
        tenantId,
        permission: args.permission,
        resourceType: ref.type,
        resourceId: ref.id,
        ancestors,
      };
    });

    const decisions: AuthorizationDecision[] = [];
    for (let start = 0; start < checks.length; start += AUTHORIZE_MANY_CHUNK_SIZE) {
      decisions.push(
        ...(await ctx.runQuery(component.checks.authorizeMany, {
          tokenIdentifier,
          checks: checks.slice(start, start + AUTHORIZE_MANY_CHUNK_SIZE),
        })),
      );
    }

    return args.resources.filter((_item, index) => decisions[index]?.allowed);
  };
}

function makeListMyTenants(component: IamComponent) {
  return async (
    ctx: IamContext,
    args?: { cursor?: string; limit?: number },
  ): Promise<TenantSummariesPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { tenants: [] };

    const result = await ctx.runQuery(component.queries.listMyTenants, {
      tokenIdentifier,
      cursor: args?.cursor,
      limit: args?.limit,
    });
    return {
      tenants: result.tenants,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListMyActiveTenants(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { cursor?: string; limit?: number; kind?: TenantKind } = {},
  ): Promise<ActiveTenantSummariesPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { tenants: [] };

    const result = await ctx.runQuery(component.queries.listMyActiveTenants, {
      tokenIdentifier,
      cursor: args.cursor,
      limit: args.limit,
      kind: args.kind,
    });
    return {
      tenants: result.tenants,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeGetTargetTenantSyncStatus(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId: string; sourceVersion: number },
  ): Promise<TargetTenantSyncStatus> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    return await ctx.runQuery(component.queries.getTargetTenantSyncStatus, {
      tokenIdentifier,
      tenantId: args.tenantId,
      sourceVersion: args.sourceVersion,
    });
  };
}

function makeGetTenantAccessStatus(component: IamComponent) {
  return async (ctx: IamContext): Promise<IamTenantAccessStatusResult> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) {
      return { kind: "fallback", reason: "identity_missing" };
    }

    return await ctx.runQuery(component.queries.getTenantAccessStatus, {
      tokenIdentifier,
    });
  };
}

function makeListMyRoles(component: IamComponent) {
  return async (ctx: IamContext, args: { tenantId?: string } = {}): Promise<RoleSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listMyRoles, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    });
  };
}

function makeGetTenant(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string } = {},
  ): Promise<TenantDetail | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    const result = await ctx.runQuery(component.queries.getTenant, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    });
    return toPublicTenantDetail(result as InternalOrPublicTenantDetail | null);
  };
}

function makeListTenantUsers(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; cursor?: string; limit?: number } = {},
  ): Promise<TenantUsersPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { users: [] };

    const result = await ctx.runQuery(component.queries.listTenantUsers, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      users: result.users,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListTenantGroups(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; cursor?: string; limit?: number } = {},
  ): Promise<TenantGroupsPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { groups: [] };

    const result = await ctx.runQuery(component.queries.listTenantGroups, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      groups: result.groups,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListTenantUserDirectory(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; cursor?: string; limit?: number } = {},
  ): Promise<TenantUserDirectoryPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { users: [] };

    const result = await ctx.runQuery(component.queries.listTenantUserDirectory, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      users: result.users,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListTenantMemberPickerUsers(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      permission: string;
      resource?: IamResourceRef;
      ancestors?: IamAuthorizationAncestor[];
      cursor?: string;
      limit?: number;
    },
  ): Promise<TenantMemberPickerUsersPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { users: [] };

    const result = await ctx.runQuery(component.queries.listTenantMemberPickerUsers, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      permission: args.permission,
      ...resourceArgs(args.resource),
      ...ancestorArgs(normalizeAncestors(args.ancestors, "listTenantMemberPickerUsers")),
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      users: result.users,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

type InternalOrPublicTenantDetail = Omit<TenantDetail, "lifecycleStatus"> & {
  lifecycleStatus: TenantDetail["lifecycleStatus"] | "disabled";
};

function toPublicTenantDetail(tenant: InternalOrPublicTenantDetail | null): TenantDetail | null {
  if (!tenant) return null;
  return {
    ...tenant,
    lifecycleStatus: tenant.lifecycleStatus === "disabled" ? "archived" : tenant.lifecycleStatus,
  };
}

function makeListResourceSharingRecipients(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      permission: string;
      resourceType: string;
      resourceId: string;
      ancestors?: IamAuthorizationAncestor[];
      recipientType: "user" | "group";
      cursor?: string;
      limit?: number;
    },
  ): Promise<SharingRecipientsPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { recipients: [] };

    const result = await ctx.runQuery(component.queries.listResourceSharingRecipients, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      permission: args.permission,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      ...ancestorArgs(normalizeAncestors(args.ancestors, "listResourceSharingRecipients")),
      recipientType: args.recipientType,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      recipients: result.recipients,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeGetTenantUserDirectoryEntry(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      userId: string;
    },
  ): Promise<TenantUserDirectoryEntry | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    return await ctx.runQuery(component.queries.getTenantUserDirectoryEntry, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      userId: args.userId,
    });
  };
}

function makeListGroupMembers(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; groupId: string; cursor?: string; limit?: number },
  ): Promise<TenantUsersPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { users: [] };

    const result = await ctx.runQuery(component.queries.listGroupMembers, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      groupId: args.groupId,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      users: result.users,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListUserGroups(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; userId: string; cursor?: string; limit?: number },
  ): Promise<TenantGroupsPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { groups: [] };

    const result = await ctx.runQuery(component.queries.listUserGroups, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      userId: args.userId,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      groups: result.groups,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

function makeListTenantRoles(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string } = {},
  ): Promise<TenantRoleSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listTenantRoles, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    });
  };
}

function makeGetTenantRole(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string; roleId: string },
  ): Promise<TenantRoleDetail | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    return await ctx.runQuery(component.queries.getTenantRole, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      roleId: args.roleId,
    });
  };
}

function makeListTenantPermissions(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: { tenantId?: string } = {},
  ): Promise<TenantPermissionSummary[]> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return [];

    return await ctx.runQuery(component.queries.listTenantPermissions, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
    });
  };
}

function makeGetResourcePermissionOverrides(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      subject: ResourcePermissionOverrideSubject;
      resourceType: string;
      target: ResourcePermissionOverrideTarget;
    },
  ): Promise<ResourcePermissionOverridesResult | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    return await ctx.runQuery(component.queries.getResourcePermissionOverrides, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      subject: args.subject,
      resourceType: args.resourceType,
      target: args.target,
    });
  };
}

function makeExplainAccess(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      userId: string;
      permission: string;
      target: ExplainAccessTarget;
    },
  ): Promise<ExplainAccessResult | null> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return null;

    return await ctx.runQuery(component.queries.explainAccess, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      userId: args.userId,
      permission: args.permission,
      target: args.target,
    });
  };
}

function makeListDirectSubjectsForResource(component: IamComponent) {
  return async (
    ctx: IamContext,
    args: {
      tenantId?: string;
      resourceType: string;
      resourceId: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<DirectResourceSubjectsPage> => {
    const tokenIdentifier = await getTokenIdentifier(ctx);
    if (!tokenIdentifier) return { subjects: [] };

    const result = await ctx.runQuery(component.queries.listDirectSubjectsForResource, {
      tokenIdentifier,
      tenantId: args.tenantId ?? DEFAULT_TENANT_SENTINEL,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      subjects: result.subjects,
      ...(result.cursor ? { nextCursor: result.cursor } : {}),
    };
  };
}

async function ensureAuthorized(
  ctx: AuthorizationCtx,
  component: IamComponent,
  mode: IamMode,
  iam: IamConfig | undefined,
  callerArgs: unknown,
) {
  const identity = await ctx.auth.getUserIdentity();

  // MED-01: short-circuit on missing identity before tenant extraction so that
  // unauthenticated callers cannot probe resource existence by observing
  // INVALID_TENANT_ARG vs RESOURCE_NOT_FOUND vs INVALID_RESOURCE_TENANT.
  if (!identity?.tokenIdentifier) {
    throw new ConvexError({
      code: mode === "permission" ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      message: mode === "permission" ? "Access denied" : "Authentication required",
      reasonCode: "missing_identity",
    });
  }

  let tenantId: string | undefined;
  let resourceType: string | undefined;
  let resourceId: string | undefined;
  let ancestors: Array<{ resourceType: string; resourceId: string }> | undefined;
  if (mode === "permission") {
    try {
      const extracted = await (iam?.tenant ?? defaultTenant)(ctx, callerArgs);
      if (typeof extracted === "string") {
        tenantId = extracted;
      } else {
        tenantId = extracted.tenantId;
        resourceType = extracted.resourceType;
        resourceId = extracted.resourceId;
        ancestors = extracted.ancestors;
      }
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "tenant extraction failed",
        reasonCode: "tenant_extract_failed",
      });
    }
  }

  const decision = await ctx.runQuery(component.checks.authorize, {
    tokenIdentifier: identity.tokenIdentifier,
    tenantId,
    permission: mode === "permission" ? iam?.permission : undefined,
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
