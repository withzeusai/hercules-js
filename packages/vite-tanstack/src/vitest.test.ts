import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Alias } from "vite";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { defineVitestConfig } from "./vitest";

function projects(config: ReturnType<typeof defineVitestConfig>): TestProjectInlineConfiguration[] {
  return (config.test?.projects ?? []) as TestProjectInlineConfiguration[];
}

describe("defineVitestConfig", () => {
  it("shares the Vite aliases and defines the convex and frontend projects", () => {
    const config = defineVitestConfig({ root: "/app" });
    const alias = config.resolve?.alias as Alias[];
    expect(alias.map((a) => a.find)).toEqual(["@/convex", "@"]);

    const [convex, frontend] = projects(config);
    expect(convex?.test).toMatchObject({
      name: "convex",
      environment: "edge-runtime",
      include: ["convex/**/*.test.{ts,js}"],
    });
    expect(frontend?.test).toMatchObject({
      name: "frontend",
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: [],
    });
    expect(config.test).toMatchObject({ passWithNoTests: true, restoreMocks: true });
  });

  it("picks up src/vitest.setup.ts when it exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hercules-vitest-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "vitest.setup.ts"), "");

    const [, frontend] = projects(defineVitestConfig({ root }));
    expect(frontend?.test?.setupFiles).toEqual(["./src/vitest.setup.ts"]);
  });

  it("drops the convex project for apps without Convex", () => {
    const config = defineVitestConfig({ root: "/app", convexDir: false });
    expect(projects(config).map((p) => p.test?.name)).toEqual(["frontend"]);
    expect((config.resolve?.alias as Alias[]).map((a) => a.find)).toEqual(["@"]);
  });

  it("lets each project be tuned or disabled", () => {
    const config = defineVitestConfig({
      root: "/app",
      convex: false,
      frontend: { include: ["tests/**/*.test.tsx"], setupFiles: ["./tests/setup.ts"] },
    });
    const [frontend] = projects(config);
    expect(projects(config)).toHaveLength(1);
    expect(frontend?.test).toMatchObject({
      include: ["tests/**/*.test.tsx"],
      setupFiles: ["./tests/setup.ts"],
    });
  });

  it("merges user vitest options over the defaults", () => {
    const config = defineVitestConfig({
      root: "/app",
      vitest: { test: { restoreMocks: false, coverage: { provider: "v8" } } },
    });
    expect(config.test).toMatchObject({
      passWithNoTests: true,
      restoreMocks: false,
      coverage: { provider: "v8" },
    });
  });
});
