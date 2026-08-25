import { describe, expect, it } from "vitest";
import type { ClientUserInfo, User } from "../types";
import { getProps, toStringArray } from "./auth-props";

const user: User = {
  id: "u1",
  email: "jane@example.com",
  emailVerified: true,
  firstName: "Jane",
  lastName: "Doe",
  profilePictureUrl: null,
};

/** Simulate a hand-built/deserialized `initialAuth` that violates the types. */
function malformedAuth(overrides: Record<string, unknown>): ClientUserInfo {
  return {
    user,
    sessionId: "sess_1",
    roles: [],
    permissions: [],
    entitlements: [],
    featureFlags: [],
    ...overrides,
  } as ClientUserInfo;
}

describe("toStringArray", () => {
  it("passes a string array through unchanged", () => {
    expect(toStringArray(["admin", "member"])).toEqual(["admin", "member"]);
  });

  it("drops non-string members from a mixed array", () => {
    expect(toStringArray(["admin", 1, null, { a: 1 }, "member", undefined])).toEqual([
      "admin",
      "member",
    ]);
  });

  it("returns [] for non-array values", () => {
    expect(toStringArray("admin")).toEqual([]);
    expect(toStringArray({})).toEqual([]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
    expect(toStringArray(42)).toEqual([]);
  });
});

describe("getProps", () => {
  it("seeds [] for every array claim when auth is undefined", () => {
    const props = getProps(undefined);
    expect(props.roles).toEqual([]);
    expect(props.permissions).toEqual([]);
    expect(props.entitlements).toEqual([]);
    expect(props.featureFlags).toEqual([]);
  });

  it("seeds [] for every array claim when signed out", () => {
    const props = getProps({ user: null });
    expect(props.user).toBeNull();
    expect(props.roles).toEqual([]);
    expect(props.permissions).toEqual([]);
    expect(props.entitlements).toEqual([]);
    expect(props.featureFlags).toEqual([]);
  });

  it("passes conforming array claims through", () => {
    const props = getProps(
      malformedAuth({ roles: ["admin"], permissions: ["posts:read", "posts:write"] }),
    );
    expect(props.roles).toEqual(["admin"]);
    expect(props.permissions).toEqual(["posts:read", "posts:write"]);
  });

  it("normalizes a bare-string roles claim to []", () => {
    expect(getProps(malformedAuth({ roles: "admin" })).roles).toEqual([]);
  });

  it("normalizes an object permissions claim to []", () => {
    expect(getProps(malformedAuth({ permissions: {} })).permissions).toEqual([]);
  });

  it("drops non-string members from mixed-type array claims", () => {
    const props = getProps(
      malformedAuth({
        entitlements: ["pro", 7, null],
        featureFlags: [true, "beta-ui"],
      }),
    );
    expect(props.entitlements).toEqual(["pro"]);
    expect(props.featureFlags).toEqual(["beta-ui"]);
  });
});
