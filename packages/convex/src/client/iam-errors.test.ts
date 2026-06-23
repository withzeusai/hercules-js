import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { classifyIamError } from "./iam-errors";

describe("classifyIamError", () => {
  test.each([
    ["principal_pending_approval", "pending_approval"],
    ["app_principal_pending_approval", "pending_approval"],
    ["principal_blocked", "blocked"],
    ["app_principal_suspended", "suspended"],
    ["principal_removed", "removed"],
    ["app_principal_missing", "missing"],
  ] as const)("classifies %s as an admission denial", (reasonCode, status) => {
    const error = new ConvexError({
      code: "ACCESS_DENIED",
      message: "Access denied",
      reasonCode,
      sourceVersion: 12,
    });

    expect(classifyIamError(error)).toEqual({
      kind: "admission",
      reasonCode,
      sourceVersion: 12,
      status,
    });
  });

  test("classifies runtime permission denials", () => {
    expect(
      classifyIamError({
        data: {
          code: "ACCESS_DENIED",
          reasonCode: "permission_denied",
          sourceVersion: 4,
        },
      }),
    ).toEqual({
      kind: "permission",
      reasonCode: "permission_denied",
      sourceVersion: 4,
    });
  });

  test("classifies a mirror that is not ready", () => {
    expect(
      classifyIamError({
        data: {
          code: "ACCESS_DENIED",
          reasonCode: "mirror_not_ready",
        },
      }),
    ).toEqual({
      kind: "temporary",
      reasonCode: "mirror_not_ready",
    });
  });

  test.each([
    {
      data: {
        code: "ACCESS_DENIED",
        reasonCode: "permission_missing",
      },
    },
    {
      data: {
        code: "UNAUTHENTICATED",
        reasonCode: "principal_missing",
      },
    },
    new Error("Network failed"),
    null,
  ])("does not reinterpret unknown or configuration errors", (error) => {
    expect(classifyIamError(error)).toBeNull();
  });
});
