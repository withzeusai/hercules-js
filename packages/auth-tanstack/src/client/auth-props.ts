import type { ClientUserInfo, NoUserInfo } from "../types";

/**
 * Coerce an untrusted value to a `string[]`. Arrays keep only their string
 * items; anything else (a bare string, an object, `null`, `undefined`)
 * becomes `[]`.
 *
 * This guards the array-claim invariant (`roles`/`permissions`/etc. are always
 * `string[]` in the auth context) against non-conforming runtime data, e.g. a
 * hand-built `initialAuth` deserialized from JSON. Server-derived auth is
 * already validated claim-by-claim, so valid input passes through unchanged.
 */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Map an auth result (or none) onto the provider's context/state shape. */
export function getProps(auth: ClientUserInfo | NoUserInfo | undefined) {
  return {
    user: auth && "user" in auth ? auth.user : null,
    sessionId: auth && "sessionId" in auth ? auth.sessionId : undefined,
    organizationId: auth && "organizationId" in auth ? auth.organizationId : undefined,
    role: auth && "role" in auth ? auth.role : undefined,
    // Array claims are always `string[]` in the context: `[]` when signed out
    // or when the claim is absent, with non-string members dropped.
    roles: toStringArray(auth && "roles" in auth ? auth.roles : undefined),
    permissions: toStringArray(auth && "permissions" in auth ? auth.permissions : undefined),
    entitlements: toStringArray(auth && "entitlements" in auth ? auth.entitlements : undefined),
    featureFlags: toStringArray(auth && "featureFlags" in auth ? auth.featureFlags : undefined),
    impersonator: auth && "impersonator" in auth ? auth.impersonator : undefined,
  };
}
