import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkIamSource, formatIamCheckResult } from "./index";

const catalog = `{
  "$schema": "https://schemas.hercules.app/iam/v1.json",
  "version": "v1",
  "permissions": {
    "app.document:read": { "name": "Read documents" },
    "app.document:manage": { "name": "Manage documents" },
  },
  "resourceTypes": {
    "app.project": { "name": "Project" },
    "app.document": { "name": "Document", "parent": "app.project" },
  },
  "roles": {
    "editor": { "name": "Editor" },
  },
  "rolePermissions": {
    "editor": ["app.document:read", "app.document:manage"],
  },
}`;

describe("checkIamSource", () => {
  test("passes a catalog and code that only reference declared keys", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { v } from "convex/values";
        import { iam, mutation, query, resource } from "./iam.js";

        export const createDocument = mutation({
          args: { projectId: v.string(), documentId: v.string(), title: v.string() },
          permission: "app.document:manage",
          resource: (_ctx, args) => ({ type: "app.project", externalId: args.projectId }),
          handler: async (ctx, args) => {
            return resource.write(ctx, {
              type: "app.document",
              externalId: args.documentId,
              parent: { type: "app.project", externalId: args.projectId },
              data: { title: args.title },
            });
          },
        });

        export const updateTitle = mutation({
          args: { documentId: v.string() },
          handler: async (ctx, args) => {
            const target = { type: "app.document", externalId: args.documentId };
            await iam.require(ctx, "app.document:manage", { resource: target });
            return resource.get(ctx, target);
          },
        });

        export const getDocument = query({
          args: { documentId: v.string() },
          handler: async (ctx, args) =>
            resource.get(ctx, {
              type: "app.document",
              externalId: args.documentId,
              permission: "app.document:read",
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("allows system.* permissions without declaring them", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/admin.ts": `
        import { query, iam } from "./iam.js";

        export const members = query({
          permission: "system.access.users:read",
          handler: async () => [],
        });

        export const check = query({
          handler: async (ctx) => iam.can(ctx, "system.access.roles:read"),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("fails a typo'd system.* permission", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/admin.ts": `
        import { query } from "./iam.js";

        export const members = query({
          permission: "system.access.tenants:raed",
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_permission", filePath: "convex/admin.ts" },
    ]);
    expect(formatIamCheckResult(result)).toContain(
      'Permission "system.access.tenants:raed" is not declared in hercules/iam.jsonc.',
    );
  });

  test("fails an undeclared permission on a builder", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query } from "./iam.js";

        export const list = query({
          permission: "app.document:write",
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_permission", filePath: "convex/documents.ts" },
    ]);
    expect(formatIamCheckResult(result)).toContain(
      'Permission "app.document:write" is not declared in hercules/iam.jsonc.',
    );
  });

  test("fails an undeclared permission passed to iam.require", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { mutation, iam } from "./iam.js";

        export const remove = mutation({
          handler: async (ctx, args) => {
            await iam.require(ctx, "app.document:destroy", {
              resource: { type: "app.document", externalId: args.documentId },
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_permission", filePath: "convex/documents.ts" },
    ]);
  });

  test("fails an undeclared permission in a resource.get filter", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query, resource } from "./iam.js";

        export const getDocument = query({
          args: {},
          handler: async (ctx, args) =>
            resource.get(ctx, {
              type: "app.document",
              externalId: args.documentId,
              permission: "app.document:reed",
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_permission", filePath: "convex/documents.ts" },
    ]);
  });

  test("fails a typo'd resource type", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query, resource } from "./iam.js";

        export const getDocument = query({
          args: {},
          handler: async (ctx, args) =>
            resource.get(ctx, {
              type: "app.documnet",
              externalId: args.documentId,
              permission: "app.document:read",
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_resource_type", filePath: "convex/documents.ts" },
    ]);
    expect(formatIamCheckResult(result)).toContain(
      'Resource type "app.documnet" is not declared in hercules/iam.jsonc.',
    );
  });

  test("fails a typo'd resource type in a type-only resource.list selector", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query, resource } from "./iam.js";

        export const list = query({
          handler: async (ctx) => resource.list(ctx, { type: "app.documnet" }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "undeclared_resource_type", filePath: "convex/documents.ts" },
    ]);
  });

  test("passes a valid type-only resource.list selector", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query, resource } from "./iam.js";

        export const list = query({
          handler: async (ctx) => resource.list(ctx, { type: "app.document" }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("skips dynamic, non-literal permission and resource values", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query, iam } from "./iam.js";

        const DOC_READ = "app.document:totally_made_up";

        export const list = query({
          permission: DOC_READ,
          handler: async (ctx, args) => {
            await iam.require(ctx, args.permission, {
              resource: { type: args.resourceType, externalId: args.id },
            });
            return [];
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("passes apps without a hercules/iam.jsonc catalog", () => {
    const root = createFixture({
      "convex/documents.ts": `
        import { query } from "./iam.js";

        export const list = query({
          permission: "app.anything:goes",
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("skips the permission check when the catalog cannot be parsed", () => {
    const root = createFixture({
      "hercules/iam.jsonc": "{ broken",
      "convex/documents.ts": `
        import { query } from "./iam.js";

        export const list = query({
          permission: "app.unknown:read",
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports a missing Convex directory", () => {
    const root = createFixture({ "hercules/iam.jsonc": catalog });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({
      ok: false,
      filesChecked: 0,
      findings: [{ code: "convex_dir_missing", filePath: "convex" }],
    });
  });

  test("describes a passing check as static and limited", () => {
    const root = createFixture({
      "hercules/iam.jsonc": catalog,
      "convex/documents.ts": `
        import { query } from "./iam.js";
        export const list = query({ permission: "app.document:read", handler: async () => [] });
      `,
    });

    const message = formatIamCheckResult(checkIamSource({ cwd: root }));

    expect(message).toContain("static check passed");
    expect(message).toContain("does not prove runtime access decisions are authorized");
  });
});

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hercules-convex-iam-check-"));
  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, filePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return root;
}
