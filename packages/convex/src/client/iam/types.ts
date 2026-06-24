import type { ActionBuilder, GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";

export const DEFAULT_API_VERSION = "2025-12-09";

export type ApiRecord = Record<string, unknown>;
export type IamHttpMethod = "get" | "post" | "patch" | "put" | "delete";

export type IamRoleReference = { id: string; key?: never } | { key: string; id?: never };

export type IamAccountEntryMode = "open" | "allowlisted_only" | "invite_only" | "approval_required";

export type IamBindingAppliesTo = "self" | "self_and_descendants";
export type IamPrincipalStatus =
  | "active"
  | "blocked"
  | "suspended"
  | "pending_approval"
  | "removed";

export type IamPermissionOverride = {
  permissionKey: string;
  effect: "allow" | "deny";
};

export type IamPermissionGrantInput = IamPermissionOverride & {
  expiresAt?: string | null;
};

export type IamResourcePermissionOverride = IamPermissionGrantInput;

export type IamRoleGrantInput = {
  role: IamRoleReference;
  expiresAt?: string | null;
};

export type IamRoleGrant = {
  grantId: string;
  type: "role";
  roleId: string;
  expiresAt: string | null;
};

export type IamPermissionGrant = {
  grantId: string;
  type: "permission";
  permissionId: string;
  permissionKey: string;
  effect: "allow" | "deny";
  expiresAt: string | null;
};

export type IamGrant = IamRoleGrant | IamPermissionGrant;

export type IamResourceRoleGrant = IamRoleGrant & {
  appliesTo: IamBindingAppliesTo;
};

export type IamResourcePermissionGrant = IamPermissionGrant & {
  appliesTo: IamBindingAppliesTo;
};

export type IamResourceGrant = IamResourceRoleGrant | IamResourcePermissionGrant;

export type IamResourceSubject =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string };

export type IamResourcePermissionSubject =
  | IamResourceSubject
  | { type: "role"; role: IamRoleReference };

export type IamGrantableRoleTarget =
  | { type: "tenant" }
  | {
      type: "resource";
      resourceType: string;
      resourceId: string;
      appliesTo?: IamBindingAppliesTo;
    };

export type IamTenantWriteResult = {
  tenantId: string;
  changed: boolean;
  sourceVersion: number;
  projectionIds: string[];
};

export type IamRequestOptions = {
  body?: ApiRecord;
  headers?: Record<string, string>;
};

export type IamSdkClient = {
  get<T>(path: string, options?: IamRequestOptions): Promise<T>;
  post<T>(path: string, options?: IamRequestOptions): Promise<T>;
  patch<T>(path: string, options?: IamRequestOptions): Promise<T>;
  put<T>(path: string, options?: IamRequestOptions): Promise<T>;
  delete<T>(path: string, options?: IamRequestOptions): Promise<T>;
};

export type IamApiOptions = {
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiVersion?: typeof DEFAULT_API_VERSION;
  client?: IamSdkClient;
};

export type IamApiCaller = (
  method: IamHttpMethod,
  path: string,
  headers: Record<string, string>,
  body?: ApiRecord,
) => Promise<ApiRecord>;

export type IamActionModuleContext<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
> = {
  builder: ActionBuilder<DataModel, Visibility>;
  actorValidators: ActorValidators;
  headersFor(args: object): Record<string, string>;
  call: IamApiCaller;
};
