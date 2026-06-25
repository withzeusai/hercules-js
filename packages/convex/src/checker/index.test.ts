import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkIamSource, formatIamCheckResult } from "./index";

const realManagedIamFixture = `
  import {
    createIam,
    tenantFromArg,
    tenantFromDefaultResource,
    tenantFromParentResource,
    tenantFromResource,
  } from "@usehercules/convex";
  import { components } from "./_generated/api";
  import { action, mutation, query } from "./_generated/server";

  const iam = createIam({ query, mutation, action, components });

  export const {
    publicQuery,
    publicMutation,
    publicAction,
    authenticatedQuery,
    authenticatedMutation,
    authenticatedAction,
    iamQuery,
    iamMutation,
    iamAction,
    checkPermissions,
    hasPermission,
    requirePermission,
    requireAnyPermission,
    getEffectivePermissions,
    getTargetTenantSyncStatus,
    listTenantUsers,
    listTenantMemberPickerUsers,
    listResourceSharingRecipients,
  } = iam;

  export {
    tenantFromArg,
    tenantFromDefaultResource,
    tenantFromParentResource,
    tenantFromResource,
  };
`;

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
        import { components, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
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
        import { components, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        const hercules = new Hercules({ apiKey: "test" });

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
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

  test("reports authorization resource type and ancestors copied from public args", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import { checkPermissions, iamQuery, tenantFromArg } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
            resource: v.object({ type: v.string(), id: v.string() }),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            const { resourceType } = args;
            const ancestors = args.ancestors;
            const request = {
              permission: "app.documents:read",
              resource: { type: resourceType, id: args.resourceId },
              ancestors,
            };
            return await checkPermissions(ctx, [
              request,
              {
                permission: "app.documents:read",
                resource: args.resource,
              },
            ]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });
    const authorizationFindings = result.findings.filter(
      (finding) => finding.code === "authorization_args_from_public_input",
    );

    expect(authorizationFindings).toHaveLength(3);
    expect(authorizationFindings.map((finding) => finding.message).join("\n")).toContain(
      "resource type",
    );
    expect(authorizationFindings.map((finding) => finding.message).join("\n")).toContain(
      "ancestors",
    );
  });

  test("does not report unrelated checkPermissions imports", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import { checkPermissions } from "unrelated-authz-package";
        import { iamQuery, tenantFromArg } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
          },
          handler: async (ctx, args) => {
            return await checkPermissions(ctx, [{
              permission: "app.documents:read",
              resource: { type: args.resourceType, id: args.resourceId },
            }]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("does not report unrelated canonical checkPermissions exports", () => {
    const root = createFixture({
      "convex/iam.ts": `
        import { createIam, tenantFromArg } from "@usehercules/convex";
        import { components } from "./_generated/api";
        import { action, mutation, query } from "./_generated/server";

        const iam = createIam({ query, mutation, action, components });
        export const { iamQuery } = iam;
        export { tenantFromArg };

        export async function checkPermissions() {
          return [];
        }
      `,
      "convex/access.ts": `
        import { v } from "convex/values";
        import { checkPermissions, iamQuery, tenantFromArg } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
          },
          handler: async (ctx, args) => {
            return await checkPermissions(ctx, [{
              permission: "app.documents:read",
              resource: { type: args.resourceType, id: args.resourceId },
            }]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("reports managed checkPermissions aliases, namespaces, and reexports", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/permissions.ts": `
        export { checkPermissions as canCheck } from "./iam";
        export * as managedIam from "./iam";
      `,
      "convex/access.ts": `
        import { v } from "convex/values";
        import * as iam from "./iam";
        import { canCheck, managedIam } from "./permissions";
        import { iamQuery, tenantFromArg } from "./iam";

        const alias = canCheck;

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            await alias(ctx, [{
              permission: "app.documents:read",
              resource: { type: args.resourceType, id: args.resourceId },
            }]);
            await iam.checkPermissions(ctx, [{
              permission: "app.documents:update",
              resource: { type: "app.documents", id: args.resourceId },
              ancestors: args.ancestors,
            }]);
            await managedIam.checkPermissions(ctx, [{
              permission: "app.documents:delete",
              resource: { type: args.resourceType, id: args.resourceId },
            }]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(3);
  });

  test("reports public authorization shape in managed permission evaluators", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import {
          getEffectivePermissions,
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          requireAnyPermission,
          requirePermission,
          tenantFromArg,
        } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            await hasPermission(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:read",
              resource: { type: args.resourceType, id: args.resourceId },
            });
            await requirePermission(ctx, {
              permission: "app.documents:update",
              resource: { type: "app.documents", id: args.resourceId },
              ancestors: args.ancestors,
            });
            await requireAnyPermission(ctx, {
              permissions: ["app.documents:update", "app.documents:delete"],
              resource: { type: args.resourceType, id: args.resourceId },
            });
            await getEffectivePermissions(ctx, {
              resource: { type: "app.documents", id: args.resourceId },
              ancestors: args.ancestors,
            });
            await listResourceSharingRecipients(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:manage_members",
              resourceType: args.resourceType,
              resourceId: args.resourceId,
              ancestors: args.ancestors,
              recipientType: "user",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(6);
  });

  test("reports the default tenant sentinel passed to Convex IAM helpers", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import {
          checkPermissions,
          getEffectivePermissions as getPermissions,
          getTargetTenantSyncStatus,
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          listTenantMemberPickerUsers,
          listTenantUsers,
        } from "./iam.js";

        const DEFAULT_TENANT_ID = "default";

        export const explain = iamQuery({
          permission: "app.documents:read",
          args: {},
          handler: async (ctx) => {
            await hasPermission(ctx, {
              tenantId: "default",
              permission: "app.documents:read",
            });
            await getPermissions(ctx, {
              tenantId: DEFAULT_TENANT_ID,
            });
            await checkPermissions(ctx, [{
              tenantId: "default",
              permission: "app.documents:read",
            }]);
            await listTenantUsers(ctx, {
              tenantId: DEFAULT_TENANT_ID,
            });
            await listTenantMemberPickerUsers(ctx, {
              tenantId: "default",
              permission: "app.documents:read",
            });
            await listResourceSharingRecipients(ctx, {
              tenantId: DEFAULT_TENANT_ID,
              permission: "app.documents:manage_members",
              resourceType: "app.documents",
              resourceId: "document_123",
              recipientType: "user",
            });
            await getTargetTenantSyncStatus(ctx, {
              tenantId: "default",
              sourceVersion: 1,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });
    const findings = result.findings.filter(
      (finding) => finding.code === "default_tenant_literal_in_convex_helper",
    );

    expect(findings).toHaveLength(7);
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ filePath: "convex/access.ts" })]),
    );
    expect(formatIamCheckResult(result)).toContain(
      'Use "default" only with generated SDK or REST APIs.',
    );
  });

  test("allows the default tenant sentinel in generated SDK calls", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { Hercules } from "@usehercules/sdk";
        import { authenticatedAction, getEffectivePermissions } from "./iam.js";

        const hercules = new Hercules({ apiKey: "test" });

        export const explain = authenticatedAction({
          args: {},
          handler: async (ctx) => {
            const identity = await ctx.auth.getUserIdentity();
            if (!identity?.tokenIdentifier) throw new Error("Authentication required");

            await hercules.iam.tenants.evaluateAccess("default", {
              user_token_identifier: identity.tokenIdentifier,
            });
            await getEffectivePermissions(ctx);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports public permission fields in managed permission evaluators", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import {
          checkPermissions,
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          listTenantMemberPickerUsers,
          requireAnyPermission,
          requirePermission,
          tenantFromArg,
        } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            permission: v.string(),
            permissions: v.array(v.string()),
            resourceId: v.string(),
          },
          handler: async (ctx, args) => {
            await checkPermissions(ctx, [{
              permission: args.permission,
              resource: { type: "app.documents", id: args.resourceId },
            }]);
            await hasPermission(ctx, {
              tenantId: args.tenantId,
              permission: args.permission,
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requirePermission(ctx, {
              permission: args.permission,
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requireAnyPermission(ctx, {
              permissions: args.permissions,
              resource: { type: "app.documents", id: args.resourceId },
            });
            await listTenantMemberPickerUsers(ctx, {
              tenantId: args.tenantId,
              permission: args.permission,
            });
            await listResourceSharingRecipients(ctx, {
              tenantId: args.tenantId,
              permission: args.permission,
              resourceType: "app.documents",
              resourceId: args.resourceId,
              recipientType: "user",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(6);
    expect(formatIamCheckResult(result)).toContain("permission");
  });

  test("allows public tenant and resource ids in managed permission evaluators", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import {
          getEffectivePermissions,
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          listTenantMemberPickerUsers,
          requireAnyPermission,
          requirePermission,
          tenantFromArg,
        } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceId: v.string(),
          },
          handler: async (ctx, args) => {
            await hasPermission(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:read",
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requirePermission(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:update",
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requireAnyPermission(ctx, {
              tenantId: args.tenantId,
              permissions: ["app.documents:update", "app.documents:delete"],
              resource: { type: "app.documents", id: args.resourceId },
            });
            await getEffectivePermissions(ctx, {
              tenantId: args.tenantId,
              resource: { type: "app.documents", id: args.resourceId },
            });
            await listTenantMemberPickerUsers(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:manage_members",
            });
            await listResourceSharingRecipients(ctx, {
              tenantId: args.tenantId,
              permission: "app.documents:manage_members",
              resourceType: "app.documents",
              resourceId: args.resourceId,
              recipientType: "user",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("allows transformed permission values in managed evaluators", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import {
          checkPermissions,
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          listTenantMemberPickerUsers,
          requireAnyPermission,
          requirePermission,
          tenantFromArg,
        } from "./iam";

        function permissionFor(kind) {
          return kind === "edit" ? "app.documents:update" : "app.documents:read";
        }

        function permissionsFor(kind) {
          return [permissionFor(kind)];
        }

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            kind: v.string(),
            resourceId: v.string(),
          },
          handler: async (ctx, args) => {
            await checkPermissions(ctx, [{
              permission: permissionFor(args.kind),
              resource: { type: "app.documents", id: args.resourceId },
            }]);
            await hasPermission(ctx, {
              tenantId: args.tenantId,
              permission: permissionFor(args.kind),
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requirePermission(ctx, {
              permission: permissionFor(args.kind),
              resource: { type: "app.documents", id: args.resourceId },
            });
            await requireAnyPermission(ctx, {
              permissions: permissionsFor(args.kind),
              resource: { type: "app.documents", id: args.resourceId },
            });
            await listTenantMemberPickerUsers(ctx, {
              tenantId: args.tenantId,
              permission: permissionFor(args.kind),
            });
            await listResourceSharingRecipients(ctx, {
              tenantId: args.tenantId,
              permission: permissionFor(args.kind),
              resourceType: "app.documents",
              resourceId: args.resourceId,
              recipientType: "user",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("does not report unrelated permission evaluator names", () => {
    const root = createFixture({
      "convex/iam.ts": `
        import { createIam, tenantFromArg } from "@usehercules/convex";
        import { components } from "./_generated/api";
        import { action, mutation, query } from "./_generated/server";

        const iam = createIam({ query, mutation, action, components });
        export const { iamQuery } = iam;
        export { tenantFromArg };

        export async function hasPermission() {
          return true;
        }

        export async function listResourceSharingRecipients() {
          return [];
        }
      `,
      "convex/access.ts": `
        import { v } from "convex/values";
        import {
          hasPermission,
          iamQuery,
          listResourceSharingRecipients,
          tenantFromArg,
        } from "./iam";

        export const explain = iamQuery({
          permission: "app.documents:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            resourceType: v.string(),
            resourceId: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            await hasPermission(ctx, {
              permission: "app.documents:read",
              resource: { type: args.resourceType, id: args.resourceId },
              ancestors: args.ancestors,
            });
            await listResourceSharingRecipients(ctx, {
              permission: "app.documents:manage_members",
              resourceType: args.resourceType,
              resourceId: args.resourceId,
              ancestors: args.ancestors,
              recipientType: "user",
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("revisits helpers when later calls pass public authorization args", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import { checkPermissions, iamQuery, tenantFromArg } from "./iam";

        async function check(ctx, request) {
          return await checkPermissions(ctx, [request]);
        }

        export const explain = iamQuery({
          permission: "app.tasks:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            taskId: v.id("tasks"),
            resourceType: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            await check(ctx, {
              permission: "app.tasks:update",
              resource: { type: "app.tasks", id: String(task._id) },
              ancestors: [{ type: "app.projects", id: String(task.projectId) }],
            });
            await check(ctx, {
              permission: "app.tasks:update",
              resource: { type: args.resourceType, id: String(task._id) },
              ancestors: args.ancestors,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(2);
  });

  test("revisits helpers for distinct public authorization arguments", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/access.ts": `
        import { v } from "convex/values";
        import { checkPermissions, iamQuery, tenantFromArg } from "./iam";

        async function check(ctx, request) {
          return await checkPermissions(ctx, [request]);
        }

        export const explain = iamQuery({
          permission: "app.tasks:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            taskId: v.id("tasks"),
            resourceType: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            await check(ctx, {
              permission: "app.tasks:update",
              resource: { type: args.resourceType, id: String(task._id) },
              ancestors: [{ type: "app.projects", id: String(task.projectId) }],
            });
            await check(ctx, {
              permission: "app.tasks:update",
              resource: { type: "app.tasks", id: String(task._id) },
              ancestors: args.ancestors,
            });
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(2);
  });

  test("reports authorizeAgainst output copied from public args", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import { iamMutation, tenantFromResource } from "./iam";

        export const update = iamMutation({
          permission: "app.tasks:update",
          tenant: async (ctx, args) =>
            tenantFromResource("tasks", "taskId", {
              authorizeAgainst: () => args.ancestors,
            })(ctx, args),
          args: {
            taskId: v.id("tasks"),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
          },
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "authorization_args_from_public_input",
          filePath: "convex/tasks.ts",
        }),
      ]),
    );
  });

  test("allows parent lookup ids but rejects public parent authorization shape", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import { iamMutation, tenantFromParentResource } from "./iam";

        export const createAllowed = iamMutation({
          permission: "app.tasks:create",
          tenant: tenantFromParentResource("projects", "projectId", {
            parentResourceType: "app.projects",
            authorizeAgainst: (project) => [
              { type: "app.workspaces", id: String(project.workspaceId) },
            ],
          }),
          args: { projectId: v.id("projects"), title: v.string() },
          handler: async () => null,
        });

        export const createUnsafeType = iamMutation({
          permission: "app.tasks:create",
          tenant: async (ctx, args) =>
            tenantFromParentResource("projects", "projectId", {
              parentResourceType: args.parentResourceType,
            })(ctx, args),
          args: {
            projectId: v.id("projects"),
            parentResourceType: v.string(),
            title: v.string(),
          },
          handler: async () => null,
        });

        export const createUnsafeAncestors = iamMutation({
          permission: "app.tasks:create",
          tenant: async (ctx, args) =>
            tenantFromParentResource("projects", "projectId", {
              parentResourceType: "app.projects",
              authorizeAgainst: () => args.ancestors,
            })(ctx, args),
          args: {
            projectId: v.id("projects"),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
            title: v.string(),
          },
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(2);
  });

  test("does not report unrelated tenant helper names", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import { iamMutation } from "./iam";

        function tenantFromParentResource() {
          return () => "tenant";
        }

        export const createTask = iamMutation({
          permission: "app.tasks:create",
          tenant: async (ctx, args) =>
            tenantFromParentResource("projects", "projectId", {
              parentResourceType: args.parentResourceType,
              authorizeAgainst: () => args.ancestors,
            })(ctx, args),
          args: {
            projectId: v.id("projects"),
            parentResourceType: v.string(),
            ancestors: v.array(v.object({
              resourceType: v.string(),
              resourceId: v.string(),
            })),
            title: v.string(),
          },
          handler: async () => null,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("allows lookup ids, trusted row ancestry, and ambiguous authorization values", () => {
    const root = createFixture({
      "convex/iam.ts": realManagedIamFixture,
      "convex/tasks.ts": `
        import { v } from "convex/values";
        import {
          checkPermissions,
          iamMutation,
          iamQuery,
          tenantFromArg,
          tenantFromResource,
        } from "./iam";

        function resourceTypeForKind(kind) {
          return kind === "task" ? "app.tasks" : "app.documents";
        }

        function ancestorsFromArgs(args) {
          return args.ancestors;
        }

        export const update = iamMutation({
          permission: "app.tasks:update",
          tenant: tenantFromResource("tasks", "taskId", {
            authorizeAgainst: (task) => [
              { type: "app.projects", id: String(task.projectId) },
            ],
          }),
          args: { taskId: v.id("tasks"), title: v.string() },
          handler: async () => null,
        });

        export const capabilities = iamQuery({
          permission: "app.tasks:read",
          tenant: tenantFromArg("tenantId"),
          args: {
            tenantId: v.string(),
            taskId: v.id("tasks"),
            kind: v.string(),
            ancestors: v.any(),
          },
          handler: async (ctx, args) => {
            const task = await ctx.db.get(args.taskId);
            if (!task) throw new Error("Task not found");
            await checkPermissions(ctx, [{
              permission: "app.tasks:update",
              resource: { type: "app.tasks", id: String(task._id) },
              ancestors: [{ type: "app.projects", id: String(task.projectId) }],
            }]);
            return await checkPermissions(ctx, [{
              permission: "app.tasks:update",
              resource: { type: resourceTypeForKind(args.kind), id: String(task._id) },
              ancestors: ancestorsFromArgs(args),
            }]);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "authorization_args_from_public_input"),
    ).toHaveLength(0);
  });

  test("reports literal creator bootstrap roles with foreign privileged permissions", () => {
    const root = createFixture({
      "hercules/iam.jsonc": `{
        "version": "v1",
        "permissions": {
          "app.projects:manage_members": { "name": "Manage project members" },
          "app.files:manage_members": { "name": "Manage file members" },
          "app.files:read": { "name": "Read files" }
        },
        "roles": {
          "owner": { "type": "built_in" },
          "admin": { "type": "built_in" },
          "member": { "type": "built_in" },
          "project_manager": { "type": "custom", "name": "Project Manager" }
        },
        "rolePermissions": {
          "project_manager": [
            "app.projects:manage_members",
            "app.files:manage_members",
            "app.files:read"
          ]
        }
      }`,
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/resources.ts": `
        import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
        import { components, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
          getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
          activateResource: internal.projects.activateCreatorBootstrap,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_creator_bootstrap_role",
          filePath: "convex/resources.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("app.files:manage_members");
  });

  test("allows compatible, tenant-created, dynamic, and unresolved creator bootstrap roles", () => {
    const root = createFixture({
      "hercules/iam.jsonc": `{
        "version": "v1",
        "permissions": {
          "app.projects:manage_members": { "name": "Manage project members" },
          "app.files:read": { "name": "Read files" }
        },
        "roles": {
          "owner": { "type": "built_in" },
          "admin": { "type": "built_in" },
          "member": { "type": "built_in" },
          "project_manager": { "type": "custom", "name": "Project Manager" }
        },
        "rolePermissions": {
          "project_manager": [
            "app.projects:manage_members",
            "app.files:read"
          ]
        }
      }`,
      "convex/iam.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/resources.ts": `
        import { createResourceCreatorBootstrapAction } from "@usehercules/convex/iam-helpers";
        import { components, internal } from "./_generated/api";
        import { authenticatedAction } from "./iam";

        const dynamicRole = { id: process.env.MANAGER_ROLE_ID };

        export const bootstrapProjectCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "project_manager" },
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
          getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
          activateResource: internal.projects.activateCreatorBootstrap,
        });

        export const bootstrapDynamicCreator = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: dynamicRole,
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
          getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
          activateResource: internal.projects.activateCreatorBootstrap,
        });

        export const bootstrapTenantCreatedRole = createResourceCreatorBootstrapAction({
          authenticatedAction,
          resourceType: "app.projects",
          managerRole: { key: "tenant_created_project_manager" },
          appliesTo: "self_and_descendants",
          getTenantAccessStatus: components.hercules.queries.getTenantAccessStatus,
          listMyTenants: components.hercules.queries.listMyTenants,
          getBootstrapTarget: internal.projects.getCreatorBootstrapTarget,
          activateResource: internal.projects.activateCreatorBootstrap,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "invalid_creator_bootstrap_role"),
    ).toHaveLength(0);
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

  test("allows tenantFromArg when a public row id is only used as a lookup key", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { iamQuery, tenantFromArg } from "./iam";

        export const resolveTitle = iamQuery({
          permission: "posts.read",
          tenant: tenantFromArg("tenantId"),
          args: { tenantId: v.string(), postId: v.id("posts") },
          handler: async (ctx, args) => {
            const post = await ctx.db.get(args.postId);
            return post?.title ?? null;
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "tenant_row_from_arg"),
    ).toHaveLength(0);
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
