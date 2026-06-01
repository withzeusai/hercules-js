import { describe, expect, test } from "vitest";
import {
  actionMatches,
  CANONICAL_ACTIONS,
  evaluateAccess,
  expandAction,
  isOwnerOnlyLever,
  MANAGE_ACTION,
  OWNER_ONLY_LEVERS,
  WILDCARD_ACTION,
  type ApplicableEntry,
} from "./authz";

// This mirrors the monorepo authz.test.ts matrix so both repos prove identical
// semantics. The constants below are the canonical Owner-only levers; if the
// monorepo ever changes them, this snapshot must change in lockstep (a drift
// silently un-fences Admin — see §0b / plan §4).

describe("action taxonomy", () => {
  test("expandAction expands manage to the canonical CRUD set", () => {
    expect(expandAction(MANAGE_ACTION)).toEqual([...CANONICAL_ACTIONS]);
  });

  test("expandAction passes through verbs and wildcard unchanged", () => {
    expect(expandAction("approve")).toEqual(["approve"]);
    expect(expandAction(WILDCARD_ACTION)).toEqual([WILDCARD_ACTION]);
  });

  test("actionMatches: wildcard matches everything", () => {
    expect(actionMatches(WILDCARD_ACTION, "read")).toBe(true);
    expect(actionMatches(WILDCARD_ACTION, "approve")).toBe(true);
  });

  test("actionMatches: manage matches canonical CRUD and itself", () => {
    for (const verb of CANONICAL_ACTIONS) {
      expect(actionMatches(MANAGE_ACTION, verb)).toBe(true);
    }
    // identity: a `manage` grant satisfies a `manage` request (a real catalog
    // action, e.g. system.roles:manage), not just the CRUD it covers.
    expect(actionMatches(MANAGE_ACTION, MANAGE_ACTION)).toBe(true);
    expect(actionMatches(MANAGE_ACTION, "approve")).toBe(false);
  });

  test("actionMatches: concrete verb requires identity", () => {
    expect(actionMatches("read", "read")).toBe(true);
    expect(actionMatches("read", "create")).toBe(false);
  });
});

describe("owner-only levers (cross-repo invariant)", () => {
  test("the canonical fence is exactly these four levers", () => {
    expect([...OWNER_ONLY_LEVERS]).toEqual([
      { resourceType: "system.app", action: "delete" },
      { resourceType: "system.ownership", action: "transfer" },
      { resourceType: "system.billing", action: MANAGE_ACTION },
      { resourceType: "system.access.owner", action: MANAGE_ACTION },
    ]);
  });

  test("concrete-verb levers fence only that verb", () => {
    expect(isOwnerOnlyLever({ resourceType: "system.app", action: "delete" })).toBe(true);
    expect(isOwnerOnlyLever({ resourceType: "system.app", action: "read" })).toBe(false);
  });

  test("manage levers fence ALL canonical CRUD on the resourceType, not just :manage", () => {
    for (const verb of CANONICAL_ACTIONS) {
      expect(isOwnerOnlyLever({ resourceType: "system.billing", action: verb })).toBe(true);
      expect(isOwnerOnlyLever({ resourceType: "system.access.owner", action: verb })).toBe(true);
    }
    expect(isOwnerOnlyLever({ resourceType: "system.billing", action: "export" })).toBe(false);
  });
});

describe("evaluateAccess — §0.4 deny-override algebra", () => {
  const allow = (
    resourceType: string,
    action: string,
    objectType: "scope" | "resource" = "scope",
    objectId?: string,
  ): ApplicableEntry => ({ effect: "allow", resourceType, action, objectType, objectId });
  const denyEntry = (
    resourceType: string,
    action: string,
    objectType: "scope" | "resource" = "scope",
    objectId?: string,
  ): ApplicableEntry => ({ effect: "deny", resourceType, action, objectType, objectId });

  test("owner immutable short-circuits allow before any entry scan", () => {
    expect(
      evaluateAccess({
        wildcard: "immutable",
        entries: [denyEntry("app.loans", "read")],
        request: { resourceType: "app.loans", action: "read" },
      }),
    ).toBe("allow");
  });

  test("admin default allows an arbitrary verb with no explicit entry", () => {
    expect(
      evaluateAccess({
        wildcard: "default",
        entries: [],
        request: { resourceType: "app.loans", action: "read" },
      }),
    ).toBe("allow");
  });

  test("admin default is fenced from owner-only levers", () => {
    expect(
      evaluateAccess({
        wildcard: "default",
        entries: [],
        request: { resourceType: "system.app", action: "delete" },
      }),
    ).toBe("deny");
    // a manage lever fences a concrete CRUD verb even with no deny row.
    expect(
      evaluateAccess({
        wildcard: "default",
        entries: [],
        request: { resourceType: "system.billing", action: "update" },
      }),
    ).toBe("deny");
  });

  test("an explicit narrowing deny beats the admin default", () => {
    expect(
      evaluateAccess({
        wildcard: "default",
        entries: [denyEntry("app.loans", "read")],
        request: { resourceType: "app.loans", action: "read" },
      }),
    ).toBe("deny");
  });

  test("none falls back to enumerated allow", () => {
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow("app.loans", "read")],
        request: { resourceType: "app.loans", action: "read" },
      }),
    ).toBe("allow");
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow("app.loans", "read")],
        request: { resourceType: "app.loans", action: "create" },
      }),
    ).toBe("deny");
  });

  test("manage allow covers CRUD but not custom verbs", () => {
    const entries = [allow("app.loans", MANAGE_ACTION)];
    for (const verb of CANONICAL_ACTIONS) {
      expect(
        evaluateAccess({ wildcard: "none", entries, request: { resourceType: "app.loans", action: verb } }),
      ).toBe("allow");
    }
    expect(
      evaluateAccess({
        wildcard: "none",
        entries,
        request: { resourceType: "app.loans", action: "approve" },
      }),
    ).toBe("deny");
  });

  test("`*` action allows a custom verb; `*` resourceType matches any type", () => {
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow("app.loans", WILDCARD_ACTION)],
        request: { resourceType: "app.loans", action: "approve" },
      }),
    ).toBe("allow");
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow(WILDCARD_ACTION, "read")],
        request: { resourceType: "app.anything", action: "read" },
      }),
    ).toBe("allow");
  });

  test("explicit deny overrides allow across layers", () => {
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow("app.loans", "read"), denyEntry("app.loans", "read")],
        request: { resourceType: "app.loans", action: "read" },
      }),
    ).toBe("deny");
  });

  test("type-level deny beats instance-level allow (all-except footgun guard)", () => {
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [
          allow("app.loans", "read", "resource", "loan_x"),
          denyEntry("app.loans", "read", "scope"),
        ],
        request: { resourceType: "app.loans", action: "read", objectId: "loan_x" },
      }),
    ).toBe("deny");
  });

  test("union on allow: distinct verbs from different layers both allowed", () => {
    const entries = [allow("app.loans", "read"), allow("app.loans", "create")];
    expect(
      evaluateAccess({ wildcard: "none", entries, request: { resourceType: "app.loans", action: "read" } }),
    ).toBe("allow");
    expect(
      evaluateAccess({ wildcard: "none", entries, request: { resourceType: "app.loans", action: "create" } }),
    ).toBe("allow");
  });

  test("implicit deny when nothing matches", () => {
    expect(
      evaluateAccess({
        wildcard: "none",
        entries: [allow("app.loans", "read")],
        request: { resourceType: "app.loans", action: "delete" },
      }),
    ).toBe("deny");
  });
});
