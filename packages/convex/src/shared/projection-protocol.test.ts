import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  accessProjectionEventSchema,
  accessProjectionSnapshotSchema,
  accessProjectionSyncPayloadSchema,
} from "./projection-protocol";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/projection-v3/", import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8"));
}

describe("Access Control projection v3 consumer schemas", () => {
  test("snapshot.json parses under the snapshot schema", () => {
    const snapshot = loadFixture("snapshot.json");

    const parsed = accessProjectionSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(accessProjectionSyncPayloadSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("event-catalog.json parses under the event schema", () => {
    const event = loadFixture("event-catalog.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  test("event-user.json parses under the event schema", () => {
    const event = loadFixture("event-user.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  test("event-scope.json parses under the event schema", () => {
    const event = loadFixture("event-scope.json");

    const parsed = accessProjectionEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(accessProjectionSyncPayloadSchema.parse(event)).toEqual(event);
  });

  test("an upsert change with a missing row fails the integrity superRefine", () => {
    const event = loadFixture("event-scope.json") as { scopes: { principals: unknown[] }[] };
    // Drop the row the principal upsert change points at; the change now matches
    // zero rows, so the C3 integrity rule must reject the event.
    const corrupted = structuredClone(event);
    corrupted.scopes[0]!.principals = [];

    const result = accessProjectionEventSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("expected exactly 1 row, found 0"),
      ),
    ).toBe(true);
  });
});
