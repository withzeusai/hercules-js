// Canonical access-control authorization algebra (ported from the monorepo).
//
// SOURCE OF TRUTH: packages/backend-shared/src/access-control/authz.ts in the
// herculesai monorepo. This file is a near-verbatim copy of the PURE algebra
// (the monorepo header explicitly anticipates this hercules-js port). The
// platform projection builder and this Convex runtime must resolve
// `can(principal, action, resource)` IDENTICALLY, so the algebra below must be
// kept byte-identical with the canonical module. Any divergence is a silent
// authorization bug.
//
// The slug-grammar parser/regex (`parseAccessPermissionKey`, etc.) and the
// seed-default `roleWildcardMode` helper from the canonical file are
// intentionally omitted: the runtime never parses keys (it resolves a
// request's structured `(resourceType, action)` via catalog lookup — see
// component/checks.ts), and the producer already computes and ships each
// role's `wildcard` mode (incl. the narrowed-Admin downgrade) in the
// projection snapshot, so re-deriving it here would be a second source of
// truth.
//
// See ACCESS_CONTROL_UX_DECISION.md §0 (authorization model) and §0b (roles &
// defaults) for the locked design this implements.

// ---------------------------------------------------------------------------
// §0.2 Canonical action taxonomy
// ---------------------------------------------------------------------------

/** The canonical CRUD-ish core. `list` is intentionally distinct from `read`. */
export const CANONICAL_ACTIONS = ["read", "create", "update", "delete", "list"] as const;
export type CanonicalAction = (typeof CANONICAL_ACTIONS)[number];

/** `manage` is the formal CRUD superset, expanded at eval time — never stored. */
export const MANAGE_ACTION = "manage";

/** `*` is all verbs (canonical + custom) on the resource type. */
export const WILDCARD_ACTION = "*";

/**
 * Expand a granted action token into the verbs it covers. `manage` expands to
 * the canonical CRUD set; every other token (canonical verb, custom verb, or
 * `*`) passes through unchanged. `*` is handled by {@link actionMatches} rather
 * than expanded to a finite list here (the universe of custom verbs is open).
 */
export function expandAction(action: string): string[] {
  return action === MANAGE_ACTION ? [...CANONICAL_ACTIONS] : [action];
}

/**
 * Does a granted action satisfy a requested action?
 *   identical → always matches (incl. `manage` granted for a `manage` request).
 *   `*`       → matches any requested verb.
 *   `manage`  → also matches any canonical CRUD verb.
 *   else      → matches only the identical verb.
 */
export function actionMatches(grantedAction: string, requestedAction: string): boolean {
  // Identity first: a grant of an action always satisfies a request for that
  // same action — including `manage` for a `manage`-action permission, which
  // the CRUD-only manage branch below would otherwise reject.
  if (grantedAction === requestedAction) return true;
  if (grantedAction === WILDCARD_ACTION) return true;
  if (grantedAction === MANAGE_ACTION) {
    return (CANONICAL_ACTIONS as readonly string[]).includes(requestedAction);
  }
  return false;
}

// ---------------------------------------------------------------------------
// §0b Wildcard role model — semantic flag, never a materialized list
// ---------------------------------------------------------------------------

/**
 * - `immutable` — Owner: implicit all-permissions-including-future; cannot be
 *   edited or narrowed; the evaluator short-circuits ALLOW before any lookup.
 * - `default`   — Admin: all-permissions-including-future by default, but
 *   builder-narrowable and fenced from the Owner-only levers
 *   ({@link OWNER_ONLY_LEVERS}). Once narrowed, the producer downgrades the
 *   role to `none` (see snapshot narrowed-admin detection).
 * - `none`      — Member / custom: enumerated grants govern.
 */
export type WildcardMode = "none" | "immutable" | "default";

/**
 * Owner-only levers — powers that a `default`-wildcard (Admin) principal is
 * fenced out of, even though it otherwise has everything. These are canonical
 * keys but are NOT seeded as permissions in Wave 1 (they are an algebra
 * constant). The fence is enforced purely in {@link evaluateAccess}.
 *
 * Each lever's `action` is matched against a request via {@link actionMatches}
 * (the same grant-side superset rule). A lever with action `manage` therefore
 * fences ALL canonical CRUD on that `resourceType`, not just a literal
 * `:manage` request — and since requests never carry `manage`/`*` (see
 * {@link RequestedAccess}), the `manage` levers must expand or they would be
 * dead. The two all-or-nothing Owner domains (billing, owner management) use
 * `manage` so every operation on them is fenced; the two single-verb levers
 * (delete app, transfer ownership) use their concrete verb.
 */
export const OWNER_ONLY_LEVERS: ReadonlyArray<{ resourceType: string; action: string }> = [
  { resourceType: "system.app", action: "delete" }, // delete app
  { resourceType: "system.ownership", action: "transfer" }, // transfer ownership
  { resourceType: "system.billing", action: MANAGE_ACTION }, // billing (all operations)
  { resourceType: "system.access.owner", action: MANAGE_ACTION }, // add/remove/demote Owner (all operations)
] as const;

/**
 * Is a requested access an Owner-only lever (Admin-fenced)? Matches by
 * `resourceType` + action-superset, so a `manage` lever fences every canonical
 * CRUD verb on its resourceType while a concrete-verb lever fences only that
 * verb. This is what makes the billing / owner-management fences effective for
 * the real CRUD requests that reach the evaluator.
 */
export function isOwnerOnlyLever(request: { resourceType: string; action: string }): boolean {
  return OWNER_ONLY_LEVERS.some(
    (lever) =>
      lever.resourceType === request.resourceType && actionMatches(lever.action, request.action),
  );
}

// ---------------------------------------------------------------------------
// §0.4 Resolution algebra — AWS deny-override, verbatim
// ---------------------------------------------------------------------------

export type Effect = "allow" | "deny";

export type RequestedAccess = {
  /** Canonical resourceType, e.g. `app.loans`. */
  resourceType: string;
  /** Requested verb (canonical or custom), e.g. `disburse`. Not `manage`/`*`. */
  action: string;
  /** Specific instance id, when the request targets a single resource. */
  objectId?: string;
};

export type ApplicableEntry = {
  effect: Effect;
  /** Granted resourceType; `*` matches any resourceType. */
  resourceType: string;
  /** Granted verb: a concrete verb, `manage`, or `*`. */
  action: string;
  /**
   * `scope`/type-level entry matches any instance of its resourceType;
   * `resource` instance-level entry matches only its own `objectId`.
   */
  objectType: "scope" | "resource";
  objectId?: string;
};

function entryMatches(entry: ApplicableEntry, request: RequestedAccess): boolean {
  // resourceType: exact match or wildcard resourceType.
  if (entry.resourceType !== WILDCARD_ACTION && entry.resourceType !== request.resourceType) {
    return false;
  }
  // action: after manage/wildcard expansion.
  if (!actionMatches(entry.action, request.action)) return false;
  // object: an instance-level (resource) entry only matches its own object.
  // A scope/type-level entry matches any instance of the type.
  if (entry.objectType === "resource") {
    return entry.objectId !== undefined && entry.objectId === request.objectId;
  }
  return true;
}

/**
 * Resolve a single access request to allow/deny per §0.4:
 *
 *   1. Owner (`immutable`) → ALLOW before any entry scan.
 *   2. Gather matching entries (resourceType + action + object).
 *   3. Explicit deny wins → DENY. (Instance-allow never beats type-deny: a
 *      type-level deny is in the matched set and short-circuits here.)
 *   4. Admin (`default`) and request is NOT an Owner-only lever → ALLOW
 *      (after the deny check, so an explicit narrowing deny still wins).
 *   5. Any matching allow that is NOT an Owner-only lever → ALLOW (role +
 *      direct grants union on allow). Owner-only levers are conferrable only by
 *      the immutable Owner at step 1.
 *   6. Else implicit DENY.
 *
 * `entries` must already be filtered to the principal, scope, and to
 * non-expired / non-revoked rows. Scope/rule denylists are fed in as `deny`
 * entries so they short-circuit at step 3 (intersection guardrail).
 */
export function evaluateAccess(args: {
  wildcard: WildcardMode;
  entries: ApplicableEntry[];
  request: RequestedAccess;
}): Effect {
  const { wildcard, entries, request } = args;

  // 1. Owner short-circuit.
  if (wildcard === "immutable") return "allow";

  // 2. Gather matching entries.
  const matching = entries.filter((entry) => entryMatches(entry, request));

  // 3. Explicit deny wins.
  if (matching.some((entry) => entry.effect === "deny")) return "deny";

  // 4. Admin wildcard default (fenced from Owner-only levers).
  if (wildcard === "default") {
    if (!isOwnerOnlyLever(request)) return "allow";
  }

  // 5. Explicit allow. Owner-only levers are conferrable ONLY by the immutable
  // Owner (step 1) — never by an explicit allow grant, mirroring the Admin
  // wildcard fence in step 4. This keeps the invariant even if such a permission
  // is somehow created and granted.
  if (!isOwnerOnlyLever(request) && matching.some((entry) => entry.effect === "allow")) {
    return "allow";
  }

  // 6. Implicit deny.
  return "deny";
}
