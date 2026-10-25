import { describe, expect, it } from "vitest";
import {
  HERCULES_DEV_MACHINE_ENV,
  HERCULES_DEV_SERVER_ENV,
  isHerculesDevMachine,
  isHerculesDevServer,
} from "./environment";

describe("isHerculesDevServer", () => {
  it("is on only when the env var is exactly 'true'", () => {
    expect(isHerculesDevServer({})).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "1" })).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "true" })).toBe(true);
  });
});

describe("isHerculesDevMachine", () => {
  it("is on only when the image's env var is exactly '1'", () => {
    expect(isHerculesDevMachine({})).toBe(false);
    expect(isHerculesDevMachine({ [HERCULES_DEV_MACHINE_ENV]: "true" })).toBe(false);
    expect(isHerculesDevMachine({ [HERCULES_DEV_MACHINE_ENV]: "1" })).toBe(true);
  });
});
