import type { DataModelFromSchemaDefinition, GenericMutationCtx } from "convex/server";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { componentModules } from "../../test/component-modules";

const write = makeFunctionReference<"mutation">("resources:write");

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type SeedCtx = GenericMutationCtx<DataModel>;

function harness() {
  return convexTest(schema, componentModules);
}

// Primary tenant plus a two-level type catalog: app.document nests under
// app.project; app.project has no parent.
async function seed(ctx: SeedCtx): Promise<void> {
  await ctx.db.insert("tenants", {
    id: "P",
    name: "Primary",
    isPrimaryTenant: true,
    status: "active",
    accessMode: "open",
    defaultRoleId: null,
    updatedAt: 0,
    sourceVersion: 1,
  });
  await ctx.db.insert("resource_types", {
    id: "rt-project",
    key: "app.project",
    name: "Project",
    parentResourceTypeId: null,
    updatedAt: 0,
    sourceVersion: 1,
  });
  await ctx.db.insert("resource_types", {
    id: "rt-document",
    key: "app.document",
    name: "Document",
    parentResourceTypeId: "rt-project",
    updatedAt: 0,
    sourceVersion: 1,
  });
}

describe("resources.write (fails loud, never a silent no-op)", () => {
  test("upserts a node and stores a matching declared parent edge", async () => {
    const t = harness();
    await t.run(seed);

    await t.mutation(write, { type: "app.project", externalId: "p1" });
    const node = await t.mutation(write, {
      type: "app.document",
      externalId: "d1",
      parent: { type: "app.project", externalId: "p1" },
    });

    expect(node).toEqual({
      type: "app.document",
      externalId: "d1",
      parent: { type: "app.project", externalId: "p1" },
    });
  });

  test("throws IAM_CONFIG for an undeclared resource type", async () => {
    const t = harness();
    await t.run(seed);

    await expect(t.mutation(write, { type: "app.task", externalId: "t1" })).rejects.toThrow(
      /Unknown resource type/,
    );
  });

  test("throws IAM_CONFIG when a parent is supplied but the type declares none", async () => {
    const t = harness();
    await t.run(seed);

    await expect(
      t.mutation(write, {
        type: "app.project",
        externalId: "p1",
        parent: { type: "app.project", externalId: "p0" },
      }),
    ).rejects.toThrow(/declares no parent/);
  });

  test("throws IAM_CONFIG when the parent type does not match the declared parent", async () => {
    const t = harness();
    await t.run(seed);

    await expect(
      t.mutation(write, {
        type: "app.document",
        externalId: "d1",
        parent: { type: "app.document", externalId: "d0" },
      }),
    ).rejects.toThrow(/declares parent/);
  });

  test("throws mirror_not_ready when no tenant has mirrored yet", async () => {
    const t = harness();

    await expect(t.mutation(write, { type: "app.project", externalId: "p1" })).rejects.toThrow(
      /mirror_not_ready/,
    );
  });
});
