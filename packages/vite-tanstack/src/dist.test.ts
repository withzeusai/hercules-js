import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dist = path.resolve(import.meta.dirname, "../dist");

/** Module specifiers that name `@usehercules/vite-common` or its source directory. */
const VITE_COMMON_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'][^"']*vite-common[^"']*["']/;

describe("dist", () => {
  // `@usehercules/vite-common` is never published, so the build must inline
  // it. The turbo `test` task builds first.
  it("does not import @usehercules/vite-common", () => {
    expect(existsSync(dist), "build the package before testing it").toBe(true);
    const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter(
      (file) => !file.endsWith(".map"),
    );
    expect(files.length).toBeGreaterThan(0);
    const importing = files.filter((file) =>
      VITE_COMMON_IMPORT.test(readFileSync(path.join(dist, file), "utf8")),
    );
    expect(importing).toEqual([]);
  });
});
