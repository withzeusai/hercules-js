import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { classifyIamError } from "./iam-errors";

describe("classifyIamError", () => {
  test.each([
    ["principal_pending_approval", "pending_approval"],
    ["app_principal_pending_approval", "pending_approval"],
    ["principal_blocked", "blocked"],
    ["app_principal_blocked", "blocked"],
    ["principal_suspended", "suspended"],
    ["app_principal_suspended", "suspended"],
    ["principal_removed", "removed"],
    ["app_principal_removed", "removed"],
    ["principal_missing", "missing"],
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

  const problemDetails = {
    requestId: "req_123",
    resourceId: "tenant_123",
  };

  const publicIamCases = [
    ["access_denied", "access", 403],
    ["user_authority_required", "access", 403],
    ["service_authority_required", "access", 403],
    ["owner_authority_required", "access", 403],
    ["source_version_conflict", "synchronization", 409],
    ["invalid_request", "operation", 400],
    ["resource_not_found", "operation", 404],
    ["state_conflict", "operation", 409],
    ["invalid_resource_role", "operation", 409],
    ["invalid_resource_permission", "operation", 409],
    ["invalid_lifecycle_transition", "operation", 400],
    ["last_owner_required", "operation", 409],
    ["grant_conflict", "operation", 409],
  ] as const;

  const makeProblem = (code: string, status?: number) => ({
    type: "https://docs.usehercules.com/errors/iam",
    title: "IAM operation failed",
    code,
    ...(status === undefined ? {} : { status }),
    details: problemDetails,
  });

  const problemContainers = [
    {
      name: "top-level problem",
      make: (code: string, status: number) => makeProblem(code, status),
    },
    {
      name: "Stainless APIError error body",
      make: (code: string, status: number) => ({
        name: "PermissionDeniedError",
        status,
        error: makeProblem(code),
      }),
    },
    {
      name: "data problem",
      make: (code: string, status: number) => ({
        status,
        data: makeProblem(code),
      }),
    },
  ] as const;

  test.each(
    publicIamCases.flatMap(([code, kind, status]) =>
      problemContainers.map((container) => ({
        code,
        container,
        expected: {
          kind,
          code,
          status,
          details: problemDetails,
        },
        status,
      })),
    ),
  )("classifies $code from a $container.name", ({ code, container, expected, status }) => {
    expect(classifyIamError(container.make(code, status))).toEqual(expected);
  });

  test("omits malformed public problem details and status", () => {
    expect(
      classifyIamError({
        code: "invalid_request",
        status: 400.5,
        details: ["not", "a", "record"],
      }),
    ).toEqual({
      kind: "operation",
      code: "invalid_request",
    });
  });

  test("does not classify unsupported body containers", () => {
    expect(
      classifyIamError({
        status: 400,
        body: makeProblem("invalid_request", 400),
      }),
    ).toBeNull();
  });

  test.each([
    { code: "future_iam_code", status: 400, details: problemDetails },
    { code: "ACCESS_DENIED", status: 403, details: problemDetails },
    { code: 123, status: 400, details: problemDetails },
    { status: 403, error: { cause: { code: "access_denied", details: problemDetails } } },
    { status: 403, error: JSON.stringify({ code: "access_denied", details: problemDetails }) },
    new Error(JSON.stringify({ code: "access_denied", details: problemDetails })),
    { status: 503 },
  ])("does not classify malformed or unknown public IAM problems", (error) => {
    expect(classifyIamError(error)).toBeNull();
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
