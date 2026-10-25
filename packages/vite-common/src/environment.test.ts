import { describe, expect, it } from "vitest";
import { HERCULES_DEV_SERVER_ENV, isHerculesDevServer } from "./environment";

describe("isHerculesDevServer", () => {
  it("is on only when the env var is exactly 'true'", () => {
    expect(isHerculesDevServer({})).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "1" })).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "true" })).toBe(true);
  });
});
