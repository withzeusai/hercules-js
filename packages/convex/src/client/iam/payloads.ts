import type {
  ApiRecord,
  IamGrantableRoleTarget,
  IamPermissionGrantInput,
  IamPermissionOverride,
  IamResourcePermissionOverride,
  IamResourcePermissionSubject,
  IamResourceSubject,
  IamRoleReference,
  IamRoleGrantInput,
} from "./types.js";

export function roleReferenceBody(reference: IamRoleReference) {
  return "id" in reference ? { id: reference.id } : { key: reference.key };
}

export function permissionOverrideBody(override: IamPermissionOverride) {
  return {
    permission_key: override.permissionKey,
    effect: override.effect,
  };
}

export function resourcePermissionOverrideBody(override: IamResourcePermissionOverride) {
  return compactBody({
    ...permissionOverrideBody(override),
    expires_at: override.expiresAt,
  });
}

export function permissionGrantBody(grant: IamPermissionGrantInput) {
  return compactBody({
    permission_key: grant.permissionKey,
    effect: grant.effect,
    expires_at: grant.expiresAt,
  });
}

export function roleGrantBody(grant: IamRoleGrantInput) {
  return compactBody({
    role: roleReferenceBody(grant.role),
    expires_at: grant.expiresAt,
  });
}

export function resourceSubjectBody(subject: IamResourceSubject) {
  return subject.type === "user"
    ? { type: "user" as const, user_id: subject.userId }
    : { type: "group" as const, group_id: subject.groupId };
}

export function resourcePermissionSubjectBody(subject: IamResourcePermissionSubject) {
  return subject.type === "role"
    ? { type: "role" as const, role: roleReferenceBody(subject.role) }
    : resourceSubjectBody(subject);
}

export function grantableRoleTargetBody(target: IamGrantableRoleTarget) {
  return target.type === "tenant"
    ? { type: "tenant" as const }
    : compactBody({
        type: "resource" as const,
        resource_type: target.resourceType,
        resource_id: target.resourceId,
        applies_to: target.appliesTo,
      });
}

export function compactBody<T extends ApiRecord>(body: T): ApiRecord {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}
