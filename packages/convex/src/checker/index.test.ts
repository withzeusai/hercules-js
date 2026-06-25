import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkIamSource, formatIamCheckResult } from "./index";

describe("checkIamSource", () => {
  test("reports exported raw Convex builders", () => {
    const root = createFixture({
      "convex/iam.ts": `
        import { createIam } from "@usehercules/convex";
        export const builders = createIam;
      `,
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

    const result = checkIamSource({ cwd: root });

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
    expect(formatIamCheckResult(result)).toContain(
      "Import from ./iam and choose publicQuery, authenticatedQuery, or iamQuery.",
    );
  });

  test("passes apps that do not use managed IAM", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { query, mutation } from "./_generated/server";
        import { v } from "convex/values";

        export const list = query({
          args: {},
          handler: async () => [],
        });

        export const create = mutation({
          args: { title: v.string() },
          handler: async () => null,
        });
      `,
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          memberships: defineTable({
            userId: v.id("users"),
            role: v.string(),
          }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("does not rewrite raw builders in apps that do not use managed IAM", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { query } from "./_generated/server";

        export const list = query({
          args: {},
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({
      cwd: root,
      fixAuthenticated: true,
    });
    const source = readFileSync(join(root, "convex/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 0, findings: [] });
    expect(source).toContain('import { query } from "./_generated/server";');
    expect(source).toContain("export const list = query({");
  });

  test("does not rewrite legacy hercules.ts wiring", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        import { createIam } from "@usehercules/convex";
        export const builders = createIam;
      `,
      "convex/posts.ts": `
        import { query } from "./_generated/server";

        export const list = query({
          args: {},
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({
      cwd: root,
      fixAuthenticated: true,
    });
    const source = readFileSync(join(root, "convex/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 0, findings: [] });
    expect(source).toContain('import { query } from "./_generated/server";');
    expect(source).toContain("export const list = query({");
    expect(source).not.toContain('from "./iam"');
  });

  test("still reports raw unguarded builders when canonical IAM wiring is configured", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/convex.config.ts": `
        import { defineApp } from "convex/server";
        import iam from "@usehercules/convex/convex.config";

        const app = defineApp();
        app.use(iam);
        export default app;
      `,
      "convex/posts.ts": `
        import { mutation } from "./_generated/server";

        export const create = mutation({
          args: {},
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "raw_exported_convex_builder",
        filePath: "convex/posts.ts",
        functionName: "create",
        builder: "mutation",
      },
    ]);
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
        import { iamMutation, authenticatedQuery } from "./iam";

        export const list = authenticatedQuery({
          args: {},
          handler: async () => [],
        });

        export const create = iamMutation({
          permission: "tasks:create",
          args: {},
          handler: async () => null,
        });

        export const repair = internalAction({
          args: {},
          handler: async () => null,
        });

        // hercules-iam: allow-raw-builder
        export const bootstrap = mutation({
          args: {},
          handler: async () => null,
        });
      `,
      "convex/_generated/server.ts": `
        export const query = () => null;
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, filesChecked: 1, findings: [] });
  });

  test("allows direct authenticatedAction and iamAction SDK IAM calls with verified identity token", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import { Hercules as HerculesClient } from "@usehercules/sdk";
        import { authenticatedAction, iamAction } from "./iam";

        const hercules = new HerculesClient({ apiKey: "test" });

        export const invite = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            await hercules.iam.tenants.invitations.createTenant("tenant_1", {
              email: "member@example.com",
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const share = iamAction({
          permission: "app.projects:share",
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity) throw new Error("Authentication required");
            if (!identity.tokenIdentifier) throw new Error("Authentication required");
            await hercules.iam.tenants.resources.grants.create("project_1", {
              tenant_id: "tenant_1",
              resource_type: "app.projects",
              role: { key: "member" },
              subject: { type: "user", user_id: "user_1" },
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test.each([
    "@usehercules/sdk/client",
    "@usehercules/sdk/client.js",
    "@usehercules/sdk/client.mjs",
    "@usehercules/sdk/index",
    "@usehercules/sdk/index.js",
    "@usehercules/sdk/index.mjs",
  ])("checks IAM calls imported from %s", (moduleSpecifier) => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/access.ts": `
        import { Hercules } from "${moduleSpecifier}";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const evaluate = authenticatedAction({
          args: {},
          handler: async () => {
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: null,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(1);
  });

  test("allows fail-closed if/else identity and token presence checks", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/access.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const truthyTokenProperty = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (identity?.tokenIdentifier) {
              // Continue with the verified token identifier.
            } else {
              throw new Error("Authentication required");
            }
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const negatedTokenProperty = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) {
              return null;
            } else {
              // Continue with the verified token identifier.
            }
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const truthyToken = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            const tokenIdentifier = identity?.tokenIdentifier;
            if (tokenIdentifier) {
              // Continue with the verified token.
            } else {
              throw new Error("Authentication required");
            }
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: tokenIdentifier,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("allows positional Stainless IAM requests and Function.call/apply", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/access.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });
        const evaluateAccess = hercules.iam.tenants.evaluateAccess;
        const updateUser = hercules.iam.tenants.users.update;

        export const update = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");

            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
            await hercules.iam.tenants.users.update(args.userId, {
              tenant_id: args.tenantId,
              roles: [],
              user_token_identifier: identity.tokenIdentifier,
            });
            await hercules.iam.tenants.resources.grants.create(args.resourceId, {
              tenant_id: args.tenantId,
              resource_type: "app.projects",
              user_token_identifier: identity.tokenIdentifier,
            });
            await hercules.iam.tenants.auditEvents.list(args.tenantId, {
              limit: 25,
              user_token_identifier: identity.tokenIdentifier,
            });
            await updateUser.call(
              hercules.iam.tenants.users,
              args.userId,
              {
                tenant_id: args.tenantId,
                roles: [],
                user_token_identifier: identity.tokenIdentifier,
              },
            );
            await evaluateAccess.apply(hercules.iam.tenants, [
              "default",
              { user_token_identifier: identity.tokenIdentifier },
            ]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("rejects invalid positional Stainless IAM request payloads", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/access.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });
        const evaluateAccess = hercules.iam.tenants.evaluateAccess;
        const updateUser = hercules.iam.tenants.users.update;

        export const invalid = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");

            await hercules.iam.tenants.evaluateAccess("default", {});
            await hercules.iam.tenants.users.update(args.userId, {
              tenant_id: args.tenantId,
              user_token_identifier: args.userTokenIdentifier,
            });
            await hercules.iam.tenants.resources.grants.create(args.resourceId, args.request);
            await hercules.iam.tenants.evaluateAccess(
              "default",
              { user_token_identifier: identity.tokenIdentifier },
              { user_token_identifier: identity.tokenIdentifier },
            );
            await updateUser.call(
              hercules.iam.tenants.users,
              args.userId,
              { tenant_id: args.tenantId, roles: [] },
            );
            await evaluateAccess.apply(hercules.iam.tenants, [
              "default",
              { user_token_identifier: args.userTokenIdentifier },
            ]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(6);
  });

  test("reports invalid authenticated SDK IAM token provenance", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });
        const constantToken = "issuer|user_1";

        export const fromArgs = authenticatedAction({
          args: {},
          handler: async (_ctx, args) => hercules.iam.tenants.users.create("tenant_1", {
            roles: [],
            user_id: "user_1",
            user_token_identifier: args.userTokenIdentifier,
          }),
        });

        export const fromConstant = authenticatedAction({
          args: {},
          handler: async () => hercules.iam.tenants.users.create("tenant_1", {
            roles: [],
            user_id: "user_1",
            user_token_identifier: constantToken,
          }),
        });

        export const camelCase = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            await hercules.iam.tenants.users.create("tenant_1", {
              roles: [],
              user_id: "user_1",
              userTokenIdentifier: identity.tokenIdentifier,
            });
          },
        });

        export const optionalIdentity = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            await hercules.iam.tenants.users.create("tenant_1", {
              roles: [],
              user_id: "user_1",
              user_token_identifier: identity?.tokenIdentifier,
            });
          },
        });

        export const identityOnly = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity) throw new Error("Authentication required");
            await hercules.iam.tenants.users.create("tenant_1", {
              roles: [],
              user_id: "user_1",
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const omitted = authenticatedAction({
          args: {},
          handler: async () => hercules.iam.tenants.users.create("tenant_1", {
            roles: [],
            user_id: "user_1",
          }),
        });

        export const dynamicSpread = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            await hercules.iam.tenants.users.create("tenant_1", {
              ...args,
              roles: [],
              user_id: "user_1",
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(7);
    expect(formatIamCheckResult(result)).toContain("user_token_identifier");
  });

  test("invalidates checked identity and token facts after reassignment or mutation", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/access.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const reassignedIdentity = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            let identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            identity = await ctx.auth.getUserIdentity();
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const reassignedToken = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            let tokenIdentifier = identity.tokenIdentifier;
            if (!tokenIdentifier) throw new Error("Authentication required");
            tokenIdentifier = identity.tokenIdentifier;
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: tokenIdentifier,
            });
          },
        });

        export const mutatedIdentity = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            identity.tokenIdentifier = args.userTokenIdentifier;
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });

        export const loopReassignedIdentity = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            let identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            for (const _value of args.values) {
              identity = await ctx.auth.getUserIdentity();
            }
            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(4);
  });

  test("resolves SDK IAM aliases, destructuring, reexports, helpers, and static spreads", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/sdk/client.ts": `
        import * as sdk from "@usehercules/sdk";

        export const hercules = new sdk.Hercules({ apiKey: "test" });
      `,
      "convex/sdk/index.ts": `
        export { hercules as client } from "./client.js";
      `,
      "convex/accessHelpers.ts": `
        import { client } from "./sdk";

        const { iam } = client;
        const users = iam.tenants.users;

        export async function createUser(ctx) {
          const identity = await ctx.auth.getUserIdentity();
          if (!identity) throw new Error("Authentication required");
          const { tokenIdentifier } = identity;
          if (!tokenIdentifier) throw new Error("Authentication required");
          const authority = { user_token_identifier: tokenIdentifier };
          return await users.create("tenant_1", {
            ...authority,
            roles: [],
            user_id: "user_1",
          });
        }
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./iam";
        import { createUser } from "./accessHelpers";

        export const create = authenticatedAction({
          args: {},
          handler: async (ctx) => createUser(ctx),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("traces transitive local helpers outside the Convex source directory", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "lib/accessHelpers.ts": `
        import { Hercules } from "@usehercules/sdk";

        const hercules = new Hercules({ apiKey: "test" });

        export async function updateUser(ctx, args) {
          const identity = await ctx.auth.getUserIdentity();
          if (!identity?.tokenIdentifier) throw new Error("Authentication required");
          return await hercules.iam.tenants.users.update(args.userId, {
            tenant_id: args.tenantId,
            user_token_identifier: args.userTokenIdentifier,
          });
        }
      `,
      "lib/index.ts": `
        export { updateUser } from "./accessHelpers.js";
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./iam";
        import { updateUser } from "../lib";

        export const update = authenticatedAction({
          args: {},
          handler: async (ctx, args) => updateUser(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsafe_sdk_iam_call",
          filePath: "lib/accessHelpers.ts",
        }),
      ]),
    );
  });

  test("rejects helper parameters and unchecked nullable tokens", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        export async function createUser(hercules, token) {
          return await hercules.iam.tenants.users.create("tenant_1", {
            roles: [],
            user_id: "user_1",
            user_token_identifier: token,
          });
        }
      `,
      "convex/projectMembers.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";
        import { createUser } from "./accessHelpers";

        const hercules = new Hercules({ apiKey: "test" });

        export const parameter = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            await createUser(hercules, identity.tokenIdentifier);
          },
        });

        export const unchecked = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            await hercules.iam.tenants.users.create("tenant_1", {
              roles: [],
              user_id: "user_1",
              user_token_identifier: identity.tokenIdentifier,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(2);
  });

  test("allows internalAction SDK IAM calls only with literal null service authority", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/service.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { internalAction } from "./_generated/server";

        const hercules = new Hercules({ apiKey: "test" });

        export const archive = internalAction({
          args: {},
          handler: async () =>
            hercules.iam.tenants.archive("tenant_1", {
              user_token_identifier: null,
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports internalAction SDK IAM calls without literal null", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/service.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { internalAction } from "./_generated/server";

        const hercules = new Hercules({ apiKey: "test" });
        const serviceActor = null;

        export const omitted = internalAction({
          args: {},
          handler: async () => hercules.iam.tenants.archive("tenant_1", {}),
        });

        export const alias = internalAction({
          args: {},
          handler: async () =>
            hercules.iam.tenants.users.update("user_1", {
              tenant_id: "tenant_1",
              user_token_identifier: serviceActor,
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(2);
  });

  test("rejects publicAction and raw action SDK IAM calls", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/publicActions.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { action } from "./_generated/server";
        import { publicAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const publicInvite = publicAction({
          args: {},
          handler: async () => hercules.iam.tenants.invitations.createTenant("tenant_1", {
            email: "member@example.com",
            user_token_identifier: null,
          }),
        });

        export const rawInvite = action({
          args: {},
          handler: async () => hercules.iam.tenants.invitations.createTenant("tenant_1", {
            email: "member@example.com",
            user_token_identifier: null,
          }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(2);
  });

  test("rejects aliased, namespace, and reexported raw action SDK IAM calls", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/rawBuilders.ts": `
        export { action as reexportedAction } from "./_generated/server.js";
      `,
      "convex/publicActions.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { action } from "./_generated/server";
        import * as server from "./_generated/server";
        import { reexportedAction } from "./rawBuilders.js";

        const hercules = new Hercules({ apiKey: "test" });
        const raw = action;

        export const aliased = raw({
          args: {},
          handler: async () => hercules.iam.tenants.archive("tenant_1", {
            user_token_identifier: null,
          }),
        });

        export const namespaced = server.action({
          args: {},
          handler: async () => hercules.iam.tenants.archive("tenant_1", {
            user_token_identifier: null,
          }),
        });

        export const reexported = reexportedAction({
          args: {},
          handler: async () => hercules.iam.tenants.archive("tenant_1", {
            user_token_identifier: null,
          }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(3);
    expect(
      result.findings.filter((finding) => finding.code === "raw_exported_convex_builder"),
    ).toHaveLength(3);
  });

  test("traces public-to-internal SDK IAM authority", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/service.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { internalAction } from "./_generated/server";

        const hercules = new Hercules({ apiKey: "test" });

        export const updateRoles = internalAction({
          args: {},
          handler: async () => hercules.iam.tenants.users.update("user_1", {
            tenant_id: "tenant_1",
            roles: [],
            user_token_identifier: null,
          }),
        });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction, publicAction } from "./iam";

        export const authenticated = authenticatedAction({
          args: {},
          handler: async (ctx) => ctx.runAction(internal.service.updateRoles, {}),
        });

        export const publicFlow = publicAction({
          args: {},
          handler: async (ctx) => ctx.runAction(internal.service.updateRoles, {}),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(1);
  });

  test("allows the resource creator bootstrap helper exception", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/resources.ts": `
        import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
        import { api, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          listMyTenants: api.iam.listMyTenants,
          getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
          activateResource: internal.projects.activateCreatorBootstrap,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports SDK IAM calls inside resource creator bootstrap config expressions", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/resources.ts": `
        import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
        import { Hercules } from "@usehercules/sdk";
        import { api, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          listMyTenants: api.iam.listMyTenants,
          getBootstrapTarget: (() => {
            hercules.iam.tenants.archive("tenant_1", {
              user_token_identifier: null,
            });
            return internal.projects.getCreatorBootstrapTarget;
          })(),
          activateResource: internal.projects.activateCreatorBootstrap,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(1);
  });

  test("describes successful checks as static and limited", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { authenticatedQuery } from "./iam";

        export const list = authenticatedQuery({
          args: {},
          handler: async () => [],
        });
      `,
    });

    const message = formatIamCheckResult(checkIamSource({ cwd: root }));

    expect(message).toContain("static check passed");
    expect(message).toContain(
      "does not prove runtime role decisions or control-plane writes are authorized",
    );
  });

  test("reports a missing Convex directory", () => {
    const root = createFixture({});
    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({
      ok: false,
      filesChecked: 0,
      findings: [{ code: "convex_dir_missing", filePath: "convex" }],
    });
  });

  test("reports placeholder Hercules tenant ids", () => {
    const root = createFixture({
      "convex/tenants.ts": `
        import { authenticatedMutation } from "./iam";

        export const create = authenticatedMutation({
          args: {},
          handler: async (ctx) => {
            await ctx.db.insert("tenants", {
              name: "Acme",
              tenantId: "",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "placeholder_tenant_id",
        filePath: "convex/tenants.ts",
      },
    ]);
    expect(formatIamCheckResult(result)).toContain("Create a Hercules IAM tenant first");
  });

  test("reports hardcoded IAM tenant ids in source", () => {
    const root = createFixture({
      "convex/iam.ts": `
        import { createIam } from "@usehercules/convex";
        export const builders = createIam;

        export const CLINIC_TENANT_ID = "01KTYRQ825E43T3PFRPZZESTPJ";

        export function getClinicTenantId() {
          return CLINIC_TENANT_ID;
        }
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hardcoded_tenant_id",
          filePath: "convex/iam.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("Do not hardcode IAM tenant ids");
  });

  test("reports app-local tenant membership tables in managed IAM apps", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          tenantMembers: defineTable({
            tenantRecordId: v.id("tenants"),
            userId: v.id("users"),
            role: v.string(),
          }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "local_tenant_membership_table", filePath: "convex/schema.ts" },
    ]);
  });

  test("reports optional tenantId and global slug lookup on tenant-scoped rows", () => {
    const root = createFixture({
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          posts: defineTable({
            tenantId: v.optional(v.string()),
            slug: v.string(),
          }).index("by_slug", ["slug"]),
        });
      `,
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { iamQuery, tenantFromArg } from "./iam";

        export const getBySlug = iamQuery({
          permission: "posts.read",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string(), slug: v.string() },
          handler: async (ctx, args) => {
            const post = await ctx.db
              .query("posts")
              .withIndex("by_slug", (q) => q.eq("slug", args.slug))
              .first();
            return post?.tenantId === args.tenantId ? post : null;
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "optional_tenant_id",
          filePath: "convex/schema.ts",
        }),
        expect.objectContaining({
          code: "tenant_scoped_global_slug_lookup",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
  });

  test("reports tenant-owned row mutations authorized from a caller supplied tenant", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { iamMutation, tenantFromArg } from "./iam";

        export const update = iamMutation({
          permission: "posts.update",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string(), postId: v.id("posts"), title: v.string() },
          handler: async (ctx, args) => {
            await ctx.db.patch(args.postId, { title: args.title });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "tenant_row_from_arg",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("tenantFromResource");
  });

  test("reports existing-row IAM operations without a resource tenant", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import { iamMutation } from "./iam";

        export const update = iamMutation({
          permission: "app.tasks:update",
          args: { taskId: v.id("tasks"), title: v.string() },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            await ctx.db.patch(args.taskId, { title: args.title });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "existing_row_missing_resource_tenant",
          filePath: "convex/tasks.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("tenantFromDefaultResource");
  });

  test("reports row capability checks without a concrete resource", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import {
          checkPermissions,
          iamQuery,
          tenantFromDefaultResource,
        } from "./iam";

        export const getCapabilities = iamQuery({
          permission: "app.tasks:read",
          tenant: tenantFromDefaultResource("tasks", "taskId"),
          args: { taskId: v.id("tasks") },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            const [decision] = await checkPermissions(ctx, [
              { permission: "app.tasks:update" },
            ]);
            return { canUpdate: decision?.allowed === true };
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "resource_capability_missing_resource",
          filePath: "convex/tasks.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("concrete resource");
  });

  test("allows existing-row IAM operations with concrete resource authorization", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import {
          checkPermissions,
          iamQuery,
          tenantFromDefaultResource,
        } from "./iam";

        export const getCapabilities = iamQuery({
          permission: "app.tasks:read",
          tenant: tenantFromDefaultResource("tasks", "taskId"),
          args: { taskId: v.id("tasks") },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            const [decision] = await checkPermissions(ctx, [
              {
                permission: "app.tasks:update",
                resource: { type: "app.tasks", id: String(task._id) },
              },
            ]);
            return { canUpdate: decision?.allowed === true };
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports authenticated reads of tenant-owned tables", () => {
    const root = createFixture({
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          posts: defineTable({
            tenantId: v.string(),
            title: v.string(),
          }),
        });
      `,
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { authenticatedQuery } from "./iam";

        export const listDrafts = authenticatedQuery({
          args: { tenantId: v.string() },
          handler: async (ctx) => ctx.db.query("posts").collect(),
        });

        export const readDraft = authenticatedQuery({
          args: { postId: v.id("posts") },
          handler: async (ctx, args) => ctx.db.get(args.postId),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "authenticated_tenant_data_read",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
  });

  test("allows role-name comparisons because syntax cannot prove authorization intent", () => {
    const root = createFixture({
      "convex/iam.ts": `
        import { createIam } from "@usehercules/convex";
        export const marker = createIam;
      `,
      "src/hooks/use-tenant.tsx": `
        export function useTenant() {
          const activeTenant = { role: "admin" as "admin" | "member" };
          return { isAdmin: activeTenant.role === "admin" };
        }
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("reports privileged permissions in resource permission rules", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const promote = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");
            await hercules.iam.tenants.resources.permissionOverrides.update(args.tenantId, {
              resource: { type: "resource", resource_id: args.projectId },
              resource_type: "app.projects",
              subject: { type: "user", user_id: args.userId },
              applies_to: "self_and_descendants",
              user_token_identifier: identity.tokenIdentifier,
              overrides: [{
                permission_key: "app.projects:manage_members",
                effect: "allow",
              }],
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "privileged_resource_permission_rule",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
    expect(
      result.findings.filter((finding) => finding.code === "unsafe_sdk_iam_call"),
    ).toHaveLength(0);
    expect(formatIamCheckResult(result)).toContain(
      "Do not grant manage_members, manage_access, system.*, or wildcard permissions through resource permission rules",
    );
  });

  test("reports access builder permission keys missing from the IAM catalog", () => {
    const root = createFixture({
      "hercules/iam.jsonc": `{
        // App permission catalog.
        "permissions": {
          "app.projects:read": { "name": "Read projects" },
          "app.projects:update": { "name": "Update projects" },
        },
      }`,
      "convex/projects.ts": `
        import { v } from "convex/values";
        import { iamQuery, iamMutation, tenantFromArg } from "./iam";

        export const list = iamQuery({
          permission: "projects:read",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string() },
          handler: async (ctx) => ctx.db.query("projects").collect(),
        });

        export const rename = iamMutation({
          permission: "app.projects:update",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string(), name: v.string() },
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "noncanonical_permission_key", filePath: "convex/projects.ts" },
    ]);
    expect(formatIamCheckResult(result)).toContain(
      'Permission key "projects:read" is not declared in hercules/iam.jsonc.',
    );
    expect(formatIamCheckResult(result)).toContain('Use the catalog key "app.projects:read"');
  });

  test("reports catalog grouping keys used as runtime permissions", () => {
    const root = createFixture({
      "hercules/iam.jsonc": `{
        "permissions": {
          "app.projects:manage": { "name": "Manage projects" },
          "app.projects:*": { "name": "All project actions" },
        },
      }`,
      "convex/projects.ts": `
        import { iamMutation, iamQuery } from "./iam";

        export const list = iamQuery({
          permission: "app.projects:*",
          handler: async () => [],
        });

        export const update = iamMutation({
          permission: "app.projects:manage",
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "runtime_superset_permission",
        filePath: "convex/projects.ts",
      },
      {
        code: "runtime_superset_permission",
        filePath: "convex/projects.ts",
      },
    ]);
    expect(formatIamCheckResult(result)).toContain("Check a concrete permission action at runtime");
  });

  test("passes catalog, system, and dynamic access builder permission keys", () => {
    const root = createFixture({
      "hercules/iam.jsonc": `{
        "permissions": {
          "app.projects:read": { "name": "Read projects" },
        },
      }`,
      "convex/projects.ts": `
        import { v } from "convex/values";
        import { iamQuery, tenantFromArg } from "./iam";

        const AUDIT_PERMISSION = "app.audit:read";

        export const list = iamQuery({
          permission: "app.projects:read",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string() },
          handler: async (ctx) => ctx.db.query("projects").collect(),
        });

        export const members = iamQuery({
          permission: "system.access.users:read",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string() },
          handler: async () => [],
        });

        export const audit = iamQuery({
          permission: AUDIT_PERMISSION,
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string() },
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("skips the catalog permission check when hercules/iam.jsonc is missing or invalid", () => {
    const builderSource = `
      import { v } from "convex/values";
      import { iamQuery, tenantFromArg } from "./iam";

      export const list = iamQuery({
        permission: "projects:read",
        tenant: tenantFromArg("tenantId"),
        args: { tenantId: v.string() },
        handler: async (ctx) => ctx.db.query("projects").collect(),
      });
    `;

    const missingCatalogRoot = createFixture({
      "convex/projects.ts": builderSource,
    });
    const invalidCatalogRoot = createFixture({
      "hercules/iam.jsonc": "{ broken",
      "convex/projects.ts": builderSource,
    });

    expect(checkIamSource({ cwd: missingCatalogRoot })).toMatchObject({
      ok: true,
      findings: [],
    });
    expect(checkIamSource({ cwd: invalidCatalogRoot })).toMatchObject({
      ok: true,
      findings: [],
    });
  });

  test("can rewrite exported raw builders to authenticated builders", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
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

    const result = checkIamSource({
      cwd: root,
      fixAuthenticated: true,
    });
    const source = readFileSync(join(root, "convex/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 1, findings: [] });
    expect(source).toContain('import { authenticatedMutation, authenticatedQuery } from "./iam";');
    expect(source).toContain("export const list = authenticatedQuery({");
    expect(source).toContain("export const create = authenticatedMutation({");
    expect(source).toContain('import { internalMutation } from "./_generated/server";');
    expect(source).toContain("export const repair = internalMutation({");
  });

  test("rewrites nested files with a relative IAM import", () => {
    const root = createFixture({
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/admin/posts.ts": `
        import { query } from "../_generated/server";

        export const list = query({
          args: {},
          handler: async () => [],
        });
      `,
    });

    const result = checkIamSource({
      cwd: root,
      fixAuthenticated: true,
    });
    const source = readFileSync(join(root, "convex/admin/posts.ts"), "utf8");

    expect(result).toMatchObject({ ok: true, fixedFiles: 1, findings: [] });
    expect(source).toContain('import { authenticatedQuery } from "../iam";');
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
