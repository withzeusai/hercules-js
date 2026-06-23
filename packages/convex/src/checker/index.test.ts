import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkIamSource, formatIamCheckResult } from "./index";

describe("checkIamSource", () => {
  test("reports exported raw Convex builders", () => {
    const root = createFixture({
      "convex/hercules.ts": `
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

  test("still reports raw unguarded builders when IAM is wired through convex.config.ts", () => {
    const root = createFixture({
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
        import { iamMutation, authenticatedQuery } from "./hercules";

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

  test("reports service-authority actions referenced by exported managed builders", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction, publicAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx) =>
            ctx.runAction(internal.iamService.assignRole, {
              scopeId: "scope_1",
            }),
        });

        const removeMember = publicAction({
          args: {},
          handler: async (ctx) =>
            ctx.runAction(internal.iamService.removeRole, {
              scopeId: "scope_1",
            }),
        });

        export { removeMember };
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("reports service-authority references hidden behind same-file helpers", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { iamAction } from "./hercules";

        async function replaceAccess(ctx, args) {
          return await ctx.runAction(internal.iamService.setResourcePermissionRules, args);
        }

        export const share = iamAction({
          permission: "app.projects:share",
          args: {},
          handler: async (ctx, args) => replaceAccess(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projects.ts",
        }),
      ]),
    );
  });

  test("reports service-authority calls hidden behind imported local helpers", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./hercules";
        import { assignRole } from "./accessHelpers";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => assignRole(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/accessHelpers.ts",
        }),
      ]),
    );
  });

  test("reports service-authority calls behind aliased and namespace public builders", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/aliased.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        const auth = authenticatedAction;
        export const addMember = auth({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.assignRole, args),
        });
      `,
      "convex/namespaced.ts": `
        import { internal } from "./_generated/api";
        import * as access from "./hercules";

        export const removeMember = access.authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.removeRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("reports imported helper aliases through barrels and emitted js specifiers", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/helpers/iam.ts": `
        import { internal } from "../_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/helpers/index.ts": `
        export { assignRole } from "./iam.js";
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./hercules";
        import { assignRole as importedAssignRole } from "./helpers/index.js";

        const delegated = importedAssignRole;
        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => delegated(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/helpers/iam.ts",
        }),
      ]),
    );
  });

  test("reports service-authority calls through namespace-imported local helpers", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./hercules";
        import * as helpers from "./accessHelpers";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => helpers.assignRole(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/accessHelpers.ts",
        }),
      ]),
    );
  });

  test("reports standalone service-authority helpers imported from iam-service", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import {
          createIamInvitation as inviteMember,
        } from "@usehercules/convex/iam-service";
        import * as iamService from "@usehercules/convex/iam-service";
        import { authenticatedAction } from "./hercules";

        export const invite = authenticatedAction({
          args: {},
          handler: async () =>
            inviteMember({
              scopeId: "scope_1",
              email: "member@example.com",
            }),
        });

        export const inviteToProject = authenticatedAction({
          args: {},
          handler: async () =>
            iamService.createResourceInvitation({
              scopeId: "scope_1",
              email: "member@example.com",
              resourceType: "app.projects",
              resourceId: "project_1",
              roleKey: "project_member",
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("resolves builders and service helpers through src namespace barrels", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/iamBuilders.ts": `
        export { authenticatedAction } from "./hercules";
      `,
      "src/access/service.ts": `
        export {
          createIamInvitation as inviteMember,
        } from "@usehercules/convex/iam-service";
      `,
      "src/access/index.ts": `
        export * as service from "./service";
      `,
      "convex/projectMembers.ts": `
        import * as access from "./iamBuilders";
        import { service } from "../src/access";

        export const invite = access.authenticatedAction({
          args: {},
          handler: async () =>
            service.inviteMember({
              scopeId: "scope_1",
              email: "member@example.com",
            }),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
  });

  test("resolves bound handlers from non-inline builder configs", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        const definition = {
          args: {},
          handler: assignRole.bind(undefined),
        };

        export const update = authenticatedAction(definition);
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("uses final static config properties after object spreads", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        const serviceConfig = {
          args: {},
          handler: assignRole,
        };
        const publicConfig = {
          ...serviceConfig,
          handler: async () => null,
        };

        export const update = authenticatedAction(publicConfig);
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("resolves statically returned handler callbacks", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function removeRole(ctx, args) {
          return await ctx.runAction(internal.iamService.removeRole, args);
        }

        function makeHandler() {
          return removeRole;
        }

        export const update = authenticatedAction({
          args: {},
          handler: makeHandler(),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("resolves destructured aliases and deterministic outer reassignments", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        async function removeRole(ctx, args) {
          return await ctx.runAction(internal.iamService.removeRole, args);
        }

        const helpers = { assignRole };

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const { assignRole: delegated } = helpers;
            return await delegated(ctx, args);
          },
        });

        export const removeMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            let delegated = async () => null;
            {
              delegated = removeRole;
            }
            return await delegated(ctx, args);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("uses the latest deterministic lexical assignment", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        export const update = authenticatedAction({
          args: {},
          handler: async () => {
            let delegated = assignRole;
            {
              delegated = async () => null;
            }
            return await delegated();
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("does not infer branch-only callable reassignments", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        export const update = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            let delegated = async () => null;
            if (args.useServiceAuthority) {
              delegated = assignRole;
            }
            return await delegated(ctx, args);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("does not infer switch or loop-only callable reassignments", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        export const throughSwitch = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            let delegated = async () => null;
            switch (args.mode) {
              case "service":
                delegated = assignRole;
                break;
            }
            return await delegated(ctx, args);
          },
        });

        export const throughLoop = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            let delegated = async () => null;
            for (const value of args.values) {
              delegated = assignRole;
            }
            return await delegated(ctx, args);
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("detects renamed modules built with createIamServiceActions", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import { createIamServiceActions } from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        export const { assignRole } = createIamServiceActions({ internalAction });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
  });

  test("detects service modules built through a namespace package import", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import * as iamService from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        export const { assignRole } = iamService.createIamServiceActions({ internalAction });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
  });

  test("marks only exports derived from createIamServiceActions", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import { createIamServiceActions } from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        const actions = createIamServiceActions({ internalAction });
        export const { assignRole } = actions;
        export const health = internalAction({
          args: {},
          handler: async () => "ok",
        });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.assignRole, args),
        });

        export const health = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.health, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("keeps safe properties separate when spreading admin actions", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import { createIamServiceActions } from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        const health = internalAction({
          args: {},
          handler: async () => "ok",
        });
        const actions = {
          health,
          ...createIamServiceActions({ internalAction }),
        };

        export const { assignRole, health: exportedHealth } = actions;
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.assignRole, args),
        });

        export const health = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.exportedHealth, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("ignores shadowed helpers and uncalled nested functions", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";
        import { assignRole } from "./accessHelpers";

        export const list = authenticatedAction({
          args: {},
          handler: async () => {
            const assignRole = async () => null;
            await assignRole();

            async function unused(ctx, args) {
              return await ctx.runAction(internal.iamService.removeRole, args);
            }

            return [];
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports direct object-property and Function.call/apply indirections", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }

        const helpers = { assignRole };

        export const throughObject = authenticatedAction({
          args: {},
          handler: async (ctx, args) => helpers.assignRole(ctx, args),
        });

        export const throughCall = authenticatedAction({
          args: {},
          handler: async (ctx, args) => assignRole.call(undefined, ctx, args),
        });

        export const throughApply = authenticatedAction({
          args: {},
          handler: async (ctx, args) => assignRole.apply(undefined, [ctx, args]),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("reports aliases of generated service-authority modules", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import { createIamServiceActions } from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        export const { assignRole } = createIamServiceActions({ internalAction });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        const rootIamService = internal.iamService;
        const nestedIamService = internal.services.iamService;

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(rootIamService.assignRole, args),
        });

        export const addProjectMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(nestedIamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("detects aliased createIamServiceActions factories", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/services/iamService.ts": `
        import { createIamServiceActions } from "@usehercules/convex/iam-service";
        import { internalAction } from "../_generated/server";

        const createServiceActions = createIamServiceActions;
        export const { assignRole } = createServiceActions({ internalAction });
      `,
      "convex/projectMembers.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.services.iamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_service_authority_call",
          filePath: "convex/projectMembers.ts",
        }),
      ]),
    );
  });

  test("resolves default exports and import-then-export barrels", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/defaultHelper.ts": `
        import { internal } from "./_generated/api";

        export default async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/namedHelper.ts": `
        import { internal } from "./_generated/api";

        export async function removeRole(ctx, args) {
          return await ctx.runAction(internal.iamService.removeRole, args);
        }
      `,
      "convex/barrel.ts": `
        import { removeRole } from "./namedHelper";
        export { removeRole };
      `,
      "convex/projectMembers.ts": `
        import { authenticatedAction } from "./hercules";
        import assignRole from "./defaultHelper";
        import { removeRole } from "./barrel";

        export const addMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => assignRole(ctx, args),
        });

        export const removeMember = authenticatedAction({
          args: {},
          handler: async (ctx, args) => removeRole(ctx, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(2);
  });

  test("keeps dangerous closure bindings from declaration scope", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { authenticatedAction } from "./hercules";
        import { assignRole as dangerousAssignRole } from "./accessHelpers";

        export const update = authenticatedAction({
          args: {},
          handler: async (ctx, args) => {
            const dangerousClosure = async () => dangerousAssignRole(ctx, args);

            {
              const dangerousAssignRole = async () => null;
              await dangerousClosure();
            }
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("keeps safe closure bindings from declaration scope", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { authenticatedAction } from "./hercules";
        import { assignRole as dangerousAssignRole } from "./accessHelpers";

        export const update = authenticatedAction({
          args: {},
          handler: async () => {
            const assignRole = async () => null;
            const safeClosure = async () => assignRole();

            {
              const assignRole = dangerousAssignRole;
              await safeClosure();
            }
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("reports service-authority calls through shorthand handler properties", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        const handler = async (ctx, args) =>
          ctx.runAction(internal.iamService.assignRole, args);

        export const update = authenticatedAction({
          args: {},
          handler,
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("ignores namespace helper imports shadowed in callable scope", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { authenticatedAction } from "./hercules";
        import * as helpers from "./accessHelpers";

        export const update = authenticatedAction({
          args: {},
          handler: async (helpers) => helpers.assignRole(),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("terminates on cyclic local callable aliases", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { authenticatedAction } from "./hercules";

        export const update = authenticatedAction({
          args: {},
          handler: async () => {
            const first = second;
            const second = first;
            await first();
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("ignores loop and generated-internal lexical shadows", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";
        import { assignRole } from "./accessHelpers";

        export const list = authenticatedAction({
          args: {},
          handler: async () => {
            for (const assignRole of [async () => null]) {
              await assignRole();
            }

            {
              const internal = {
                iamService: {
                  assignRole: async () => null,
                },
              };
              await internal.iamService.assignRole();
            }

            return [];
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("ignores generated-internal lexical shadows in switch clauses", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./hercules";

        export const update = authenticatedAction({
          args: {},
          handler: async (value) => {
            switch (value) {
              case "safe":
                const internal = {
                  iamService: {
                    assignRole: async () => null,
                  },
                };
                await internal.iamService.assignRole();
                break;
            }
          },
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("treats passing a known dangerous callable as public exposure", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/accessHelpers.ts": `
        import { internal } from "./_generated/api";

        export async function assignRole(ctx, args) {
          return await ctx.runAction(internal.iamService.assignRole, args);
        }
      `,
      "convex/projects.ts": `
        import { authenticatedAction } from "./hercules";
        import { assignRole } from "./accessHelpers";

        const invoke = (callback, ctx, args) => callback(ctx, args);
        const ignore = (_callback) => null;

        export const invoked = authenticatedAction({
          args: {},
          handler: async (ctx, args) => invoke(assignRole, ctx, args),
        });

        export const ignored = authenticatedAction({
          args: {},
          handler: async () => ignore(assignRole),
        });

        export const safe = authenticatedAction({
          args: {},
          handler: async () => ignore(async () => null),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    // The checker does not infer whether arbitrary higher-order functions call
    // their arguments. Passing a statically dangerous callable from a public
    // handler is itself treated as service-authority exposure.
    expect(
      result.findings.filter((finding) => finding.code === "public_service_authority_call"),
    ).toHaveLength(1);
  });

  test("does not treat unrelated builder-shaped imports as public roots", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/fakeBuilders.ts": `
        export const authenticatedAction = (definition) => definition;
      `,
      "convex/named.ts": `
        import { internal } from "./_generated/api";
        import { authenticatedAction } from "./fakeBuilders";

        export const run = authenticatedAction({
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.assignRole, args),
        });
      `,
      "convex/namespaced.ts": `
        import { internal } from "./_generated/api";
        import * as fakeBuilders from "./fakeBuilders";

        export const run = fakeBuilders.authenticatedAction({
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("ignores unreachable service references in internal-only functions", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { internal } from "./_generated/api";
        import { internalAction } from "./_generated/server";
        import { authenticatedAction } from "./hercules";

        export const list = authenticatedAction({
          args: {},
          handler: async () => [],
        });

        export const repair = internalAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.assignRole, args),
        });
      `,
      "convex/repairs.ts": `
        import { internal } from "./_generated/api";
        import { internalAction } from "./_generated/server";

        export const repair = internalAction({
          args: {},
          handler: async (ctx, args) =>
            ctx.runAction(internal.iamService.assignRole, args),
        });
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test("describes successful checks as static and limited", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projects.ts": `
        import { authenticatedQuery } from "./hercules";

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

  test("reports placeholder Hercules org scope ids", () => {
    const root = createFixture({
      "convex/organizations.ts": `
        import { authenticatedMutation } from "./iam";

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

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: "placeholder_access_scope_id",
        filePath: "convex/organizations.ts",
      },
    ]);
    expect(formatIamCheckResult(result)).toContain("Create a Hercules IAM scope first");
  });

  test("reports hardcoded IAM scope ids in source", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/iam.ts": `
        import { getEffectivePermissions } from "./hercules";

        export const CLINIC_SCOPE_ID = "01KTYRQ825E43T3PFRPZZESTPJ";

        export async function getMyPermissions(ctx: unknown) {
          return await getEffectivePermissions(ctx, { scopeId: CLINIC_SCOPE_ID });
        }
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hardcoded_access_scope_id",
          filePath: "convex/iam.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("Do not hardcode IAM scope ids");
  });

  test("reports app-local org membership tables in managed IAM apps", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
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

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      { code: "local_org_membership_table", filePath: "convex/schema.ts" },
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
        import { iamQuery, scopeFromArg } from "./iam";

        export const getBySlug = iamQuery({
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

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "optional_org_scope_id",
          filePath: "convex/schema.ts",
        }),
        expect.objectContaining({
          code: "org_scoped_global_slug_lookup",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
  });

  test("reports org-owned row mutations authorized from a caller supplied scope", () => {
    const root = createFixture({
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { iamMutation, scopeFromArg } from "./hercules";

        export const update = iamMutation({
          permission: "posts.update",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string(), postId: v.id("posts"), title: v.string() },
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
          code: "org_row_scope_from_arg",
          filePath: "convex/posts.ts",
        }),
      ]),
    );
    expect(formatIamCheckResult(result)).toContain("scopeFromResource");
  });

  test("reports authenticated reads of org-owned tables", () => {
    const root = createFixture({
      "convex/schema.ts": `
        import { defineSchema, defineTable } from "convex/server";
        import { v } from "convex/values";

        export default defineSchema({
          posts: defineTable({
            orgScopeId: v.string(),
            title: v.string(),
          }),
        });
      `,
      "convex/posts.ts": `
        import { v } from "convex/values";
        import { authenticatedQuery } from "./hercules";

        export const listDrafts = authenticatedQuery({
          args: { orgScopeId: v.string() },
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
          code: "authenticated_org_data_read",
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
      "src/hooks/use-org.tsx": `
        export function useOrg() {
          const activeOrg = { role: "admin" as "admin" | "member" };
          return { isAdmin: activeOrg.role === "admin" };
        }
      `,
    });

    const result = checkIamSource({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("reports privileged permissions in resource permission rules", () => {
    const root = createFixture({
      "convex/hercules.ts": `
        export { createIam } from "@usehercules/convex";
      `,
      "convex/projectMembers.ts": `
        import { api } from "./_generated/api";

        export async function promote(ctx, args) {
          await ctx.runAction(api.iamManagement.setResourcePermissionRule, {
            scopeId: args.scopeId,
            subject: { type: "principal", principalId: args.principalId },
            resourceType: "app.projects",
            target: { mode: "specific", resourceId: args.projectId },
            permissionKey: "app.projects:manage_members",
            effect: "allow",
            appliesTo: "self_and_descendants",
            idToken: args.idToken,
          });
        }
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
        import { iamQuery, iamMutation, scopeFromArg } from "./hercules";

        export const list = iamQuery({
          permission: "projects:read",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string() },
          handler: async (ctx) => ctx.db.query("projects").collect(),
        });

        export const rename = iamMutation({
          permission: "app.projects:update",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string(), name: v.string() },
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
        import { iamQuery, scopeFromArg } from "./hercules";

        const AUDIT_PERMISSION = "app.audit:read";

        export const list = iamQuery({
          permission: "app.projects:read",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string() },
          handler: async (ctx) => ctx.db.query("projects").collect(),
        });

        export const members = iamQuery({
          permission: "system.members:read",
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string() },
          handler: async () => [],
        });

        export const audit = iamQuery({
          permission: AUDIT_PERMISSION,
          scope: scopeFromArg("orgScopeId"),
          args: { orgScopeId: v.string() },
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
      import { iamQuery, scopeFromArg } from "./hercules";

      export const list = iamQuery({
        permission: "projects:read",
        scope: scopeFromArg("orgScopeId"),
        args: { orgScopeId: v.string() },
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
      "convex/hercules.ts": `
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

  test("rewrites nested files with a relative Hercules import", () => {
    const root = createFixture({
      "convex/hercules.ts": `
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
