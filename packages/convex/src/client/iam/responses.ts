import type {
  ApiRecord,
  IamAccountEntryMode,
  IamBindingAppliesTo,
  IamGrant,
  IamPermissionGrant,
  IamPrincipalStatus,
  IamResourceGrant,
  IamResourcePermissionGrant,
  IamResourceRoleGrant,
  IamRoleGrant,
  IamTenantWriteResult,
} from "./types.js";

export function normalizeTenantWriteResult(result: ApiRecord): IamTenantWriteResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    changed: requiredBoolean(result, "changed", "changed"),
    sourceVersion: requiredNumber(result, "source_version", "sourceVersion"),
    projectionIds: requiredStringArray(result, "projection_ids", "projectionIds"),
  };
}

export function normalizeGrant(result: ApiRecord, resultName = "grant"): IamGrant {
  const type = requiredString(result, "type", `${resultName}.type`);
  const common = {
    grantId: requiredString(result, "grant_id", `${resultName}.grantId`),
    expiresAt: nullableString(result, "expires_at", `${resultName}.expiresAt`),
  };
  if (type === "role") {
    return {
      ...common,
      type,
      roleId: requiredString(result, "role_id", `${resultName}.roleId`),
    } satisfies IamRoleGrant;
  }
  if (type === "permission") {
    return {
      ...common,
      type,
      permissionId: requiredString(result, "permission_id", `${resultName}.permissionId`),
      permissionKey: requiredString(result, "permission_key", `${resultName}.permissionKey`),
      effect: requiredEffect(result, "effect", `${resultName}.effect`),
    } satisfies IamPermissionGrant;
  }
  throw new Error(`IAM API response has invalid ${resultName}.type.`);
}

export function normalizeResourceGrant(result: ApiRecord, resultName = "grant"): IamResourceGrant {
  const grant = normalizeGrant(result, resultName);
  const appliesTo = requiredAppliesTo(result, "applies_to", `${resultName}.appliesTo`);
  return grant.type === "role"
    ? ({ ...grant, appliesTo } satisfies IamResourceRoleGrant)
    : ({ ...grant, appliesTo } satisfies IamResourcePermissionGrant);
}

export function requiredRecord(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value as ApiRecord;
}

export function requiredRecordArray(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))
  ) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value as ApiRecord[];
}

export function requiredString(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

export function optionalString(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function nullableString(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function optionalNullableString(result: ApiRecord, apiKey: string, resultName: string) {
  if (!(apiKey in result)) return undefined;
  return nullableString(result, apiKey, resultName);
}

export function requiredNumber(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (typeof value !== "number") {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

export function requiredBoolean(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (typeof value !== "boolean") {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

export function requiredTrue(result: ApiRecord, apiKey: string, resultName: string): true {
  if (result[apiKey] !== true) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return true;
}

export function requiredStringArray(result: ApiRecord, apiKey: string, resultName: string) {
  const value = result[apiKey];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`IAM API response missing ${resultName}.`);
  }
  return value;
}

export function optionalStringArray(result: ApiRecord, apiKey: string, resultName: string) {
  if (!(apiKey in result)) return undefined;
  return requiredStringArray(result, apiKey, resultName);
}

export function requiredEffect(
  result: ApiRecord,
  apiKey: string,
  resultName: string,
): "allow" | "deny" {
  const value = result[apiKey];
  if (value !== "allow" && value !== "deny") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function requiredRoleKind(
  result: ApiRecord,
  apiKey: string,
  resultName: string,
): "system" | "custom" {
  const value = result[apiKey];
  if (value !== "system" && value !== "custom") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function requiredAppliesTo(
  result: ApiRecord,
  apiKey: string,
  resultName: string,
): IamBindingAppliesTo {
  const value = result[apiKey];
  if (value !== "self" && value !== "self_and_descendants") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function requiredPrincipalStatus(
  result: ApiRecord,
  apiKey: string,
  resultName: string,
): IamPrincipalStatus {
  const value = result[apiKey];
  if (
    value !== "active" &&
    value !== "blocked" &&
    value !== "suspended" &&
    value !== "pending_approval" &&
    value !== "removed"
  ) {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

export function optionalPrincipalStatus(result: ApiRecord, apiKey: string, resultName: string) {
  if (!(apiKey in result)) return undefined;
  return requiredPrincipalStatus(result, apiKey, resultName);
}

export function optionalEntryMode(
  result: ApiRecord,
  apiKey: string,
  resultName: string,
): IamAccountEntryMode | undefined {
  const value = result[apiKey];
  if (value === undefined || value === null) return undefined;
  if (
    value !== "open" &&
    value !== "allowlisted_only" &&
    value !== "invite_only" &&
    value !== "approval_required"
  ) {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}
