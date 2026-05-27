import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkAccessControlSource,
  formatAccessControlCheckResult,
} from "./index";

describe("checkAccessControlSource", () => {
  test("reports exported raw Convex builders", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { query, mutation as rawMutation, internalMutation } from "./_generated/server";
        import { v } from "convex/values";

        export const list = query({
          args: {},
          handler: async () => [],
        });

        const create = rawMutation({
          args: { title: v.string() },
          handler: async () => null,
        });

        const repair = internalMutation({
          args: {},
          handler: async () => null,
        });

        export { create, repair };
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "raw_exported_convex_builder",
        filePath: "convex/posts.ts",
        functionName: "list",
        builder: "query",
      },
      {
        code: "raw_exported_convex_builder",
        filePath: "convex/posts.ts",
        functionName: "create",
        builder: "mutation",
      },
    ]);
    expect(formatAccessControlCheckResult(result)).toContain(
      "Import from ./access and choose publicQuery, authenticatedQuery, or accessQuery.",
    );
  });

  test("passes managed builders, internal functions, and local exemptions", () => {
    const root = createFixture({
      "convex/http.ts": `
        import { httpRouter } from "convex/server";
        const http = httpRouter();
        export default http;
      `,
      "convex/tasks.ts": `
        import { internalAction, mutation } from "./_generated/server";
        import { accessMutation, authenticatedQuery } from "./access";

        export const list = authenticatedQuery({
          args: {},
          handler: async () => [],
        });

        export const create = accessMutation({
          permission: "tasks:create",
          args: {},
          handler: async () => null,
        });

        export const repair = internalAction({
          args: {},
          handler: async () => null,
        });

        // hercules-access-control: allow-raw-builder
        export const bootstrap = mutation({
          args: {},
          handler: async () => null,
        });
      `,
      "convex/_generated/server.ts": `
        export const query = () => null;
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result).toMatchObject({
      ok: true,
      filesChecked: 1,
      findings: [],
    });
  });

  test("reports a missing Convex directory", () => {
    const root = createFixture({});
    const result = checkAccessControlSource({ cwd: root });

    expect(result).toMatchObject({
      ok: false,
      filesChecked: 0,
      findings: [
        {
          code: "convex_dir_missing",
          filePath: "convex",
        },
      ],
    });
  });

  test("reports placeholder Hercules org scope ids", () => {
    const root = createFixture({
      "convex/organizations.ts": `
        import { authenticatedMutation } from "./access";

        export const create = authenticatedMutation({
          args: {},
          handler: async (ctx) => {
            await ctx.db.insert("organizations", {
              name: "Acme",
              herculesScopeId: "",
            });
          },
        });
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "placeholder_access_scope_id",
        filePath: "convex/organizations.ts",
      },
    ]);
    expect(formatAccessControlCheckResult(result)).toContain(
      "Create a Hercules Access Control scope first",
    );
  });

  test("reports app-local org membership tables in managed Access Control apps", () => {
    const root = createFixture({
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          orgMembers: defineTable({
            orgId: v.id("organizations"),
            userId: v.id("users"),
            role: v.string(),
          }),
        });
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "local_org_membership_table",
        filePath: "convex/schema.ts",
      },
    ]);
  });

  test("reports optional orgScopeId and global slug lookup on org-scoped rows", () => {
    const root = createFixture({
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          posts: defineTable({
            orgScopeId: v.optional(v.string()),
            slug: v.string(),
          }).index("by_slug", ["slug"]),
        });
      `,
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { accessQuery, scopeFromArg } from "./access";

        export const getBySlug = accessQuery({
          permission: "posts.read",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string(), slug: v.string() },
          handler: async (ctx, args) => {
            const post = await ctx.db
              .query("posts")
              .withIndex("by_slug", (q) => q.eq("slug", args.slug))
              .first();
            return post?.orgScopeId === args.orgScopeId ? post : null;
          },
        });
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "optional_org_scope_id", filePath: "convex/schema.ts" }),
        expect.objectContaining({
          code: "org_scoped_global_slug_lookup",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
  });

  test("reports frontend role-name permission gates", () => {
    const root = createFixture({
      "convex/access.ts": `
        export const marker = true;
      `,
      "src/hooks/use-org.tsx": `
        export function useOrg() {
          const activeOrg = { role: "admin" as "admin" | "member" };
          return { isAdmin: activeOrg.role === "admin" };
        }
      `,
    });

    const result = checkAccessControlSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "role_name_permission_gate",
        filePath: "src/hooks/use-org.tsx",
      },
    ]);
  });

  test("can rewrite exported raw builders to authenticated builders", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { query, mutation as rawMutation, internalMutation } from "./_generated/server";
        import { v } from "convex/values";

        export const list = query({
          args: {},
          handler: async () => [],
        });

        export const create = rawMutation({
          args: { title: v.string() },
          handler: async () => null,
        });

        export const repair = internalMutation({
          args: {},
          handler: async () => null,
        });
      `,
    });

    const result = checkAccessControlSource({ cwd: root, fixAuthenticated: true });
    const source = readFileSync(join(root, "convex/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 1, findings: [] });
    expect(source).toContain(
      'import { authenticatedMutation, authenticatedQuery } from "./access";',
    );
    expect(source).toContain("export const list = authenticatedQuery({");
    expect(source).toContain("export const create = authenticatedMutation({");
    expect(source).toContain('import { internalMutation } from "./_generated/server";');
    expect(source).toContain("export const repair = internalMutation({");
  });

  test("rewrites nested files with a relative access import", () => {
    const root = createFixture({
      "convex/admin/posts.ts": `
        import { query } from "../_generated/server";

        export const list = query({
          args: {},
          handler: async () => [],
        });
      `,
    });

    const result = checkAccessControlSource({ cwd: root, fixAuthenticated: true });
    const source = readFileSync(join(root, "convex/admin/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 1, findings: [] });
    expect(source).toContain('import { authenticatedQuery } from "../access";');
    expect(source).toContain("export const list = authenticatedQuery({");
  });
});

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hercules-access-check-"));

  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, filePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  return root;
}
