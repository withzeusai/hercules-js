import { describe, expect, test } from "vitest";
import * as iam from "./index";
import { createIamManagementActions } from "./iam-management";
import { createIamServiceActions } from "./iam-service";
import { registerIamRoutes } from "./http";

describe("IAM public surface", () => {
  test("exposes only IAM factory names", () => {
    const exports = iam as Record<string, unknown>;

    expect(exports.createIam).toBeTypeOf("function");
    expect(createIamManagementActions).toBeTypeOf("function");
    expect(createIamServiceActions).toBeTypeOf("function");
    expect(registerIamRoutes).toBeTypeOf("function");
    expect(exports).not.toHaveProperty("createAccessControl");
  });
});
