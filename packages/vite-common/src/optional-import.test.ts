import { afterEach, describe, expect, it, vi } from "vitest";
import { importOptional, isModuleNotFound } from "./optional-import";

const owner = "@usehercules/test";

function notFound(): Error {
  return Object.assign(new Error("Cannot find package 'missing'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isModuleNotFound", () => {
  it("recognizes ESM and CJS resolution failures", () => {
    expect(isModuleNotFound(notFound())).toBe(true);
    expect(isModuleNotFound(Object.assign(new Error("x"), { code: "MODULE_NOT_FOUND" }))).toBe(
      true,
    );
    expect(isModuleNotFound(new Error("Cannot find module 'missing'"))).toBe(true);
    expect(isModuleNotFound(new Error("boom"))).toBe(false);
    expect(isModuleNotFound(undefined)).toBe(false);
  });
});

describe("importOptional", () => {
  it("returns the module when it loads", async () => {
    await expect(
      importOptional("present", async () => "module", { explicit: false, owner }),
    ).resolves.toBe("module");
  });

  it("skips a missing package with a warning unless it was configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importOptional("missing", () => Promise.reject(notFound()), { explicit: false, owner }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[${owner}] \`missing\` is not installed; skipping it.`);
  });

  it("fails on a missing package that was configured", async () => {
    await expect(
      importOptional("missing", () => Promise.reject(notFound()), { explicit: true, owner }),
    ).rejects.toThrow(
      `[${owner}] \`missing\` is configured in vite.config.ts but is not installed`,
    );
  });

  it("rethrows other errors", async () => {
    const error = new Error("boom");
    await expect(
      importOptional("broken", () => Promise.reject(error), { explicit: false, owner }),
    ).rejects.toBe(error);
  });
});
