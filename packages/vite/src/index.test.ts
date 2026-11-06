import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { hercules } from "./index";

const BUILD_TOOLS = [
  "vite",
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "@vitejs/plugin-react-swc",
];

describe("hercules", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("keeps Vite and its plugins out of the dev dependency optimizer", async () => {
    root = mkdtempSync(path.join(tmpdir(), "hercules-vite-"));
    const resolved = await resolveConfig({ root, configFile: false, plugins: hercules() }, "serve");
    expect(resolved.optimizeDeps.exclude).toEqual(expect.arrayContaining(BUILD_TOOLS));
  });
});
