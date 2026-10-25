import { existsSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import {
  mergeConfig,
  type TestProjectConfiguration,
  type ViteUserConfig as UserConfig,
} from "vitest/config";
import { herculesAliases } from "./aliases";

export interface HerculesVitestProjectOptions {
  /** Glob patterns for the project's test files. */
  include?: string[];
  /** Vitest environment. */
  environment?: string;
  /** Setup files, relative to the root. */
  setupFiles?: string[];
}

export interface HerculesVitestOptions {
  /**
   * Project root.
   * @default process.cwd()
   */
  root?: string;

  /**
   * Application source directory, relative to the root. Mapped to `@`.
   * @default "src"
   */
  srcDir?: string;

  /**
   * Convex functions directory, relative to the root. Mapped to `@/convex`.
   * Pass `false` for apps without Convex; this also drops the convex project.
   * @default "convex"
   */
  convexDir?: string | false;

  /**
   * The `convex` project: backend functions run in the edge runtime through
   * `convex-test`. Requires `@edge-runtime/vm` in the app. Pass `false` to
   * skip it.
   */
  convex?: HerculesVitestProjectOptions | false;

  /**
   * The `frontend` project: React components and logic run in jsdom through
   * Testing Library. Requires `jsdom` in the app. Pass `false` to skip it.
   *
   * `<srcDir>/vitest.setup.ts` is used as a setup file when it exists.
   */
  frontend?: HerculesVitestProjectOptions | false;

  /** Vitest options merged over the generated config. */
  vitest?: UserConfig;
}

/**
 * Vitest config for a Hercules TanStack Start app: the same path aliases as
 * the Vite config plus the two-project layout every app starts with.
 *
 * @example
 * ```ts
 * import { defineVitestConfig } from "@usehercules/vite-tanstack/vitest";
 * export default defineVitestConfig();
 * ```
 */
export function defineVitestConfig(options: HerculesVitestOptions = {}): UserConfig {
  const root = path.resolve(options.root ?? process.cwd());
  const { srcDir = "src", convexDir = "convex" } = options;

  const projects: TestProjectConfiguration[] = [];

  if (convexDir !== false && options.convex !== false) {
    const convex = options.convex ?? {};
    projects.push({
      extends: true,
      test: {
        name: "convex",
        environment: convex.environment ?? "edge-runtime",
        include: convex.include ?? [`${convexDir}/**/*.test.{ts,js}`],
        ...(convex.setupFiles ? { setupFiles: convex.setupFiles } : {}),
      },
    });
  }

  if (options.frontend !== false) {
    const frontend = options.frontend ?? {};
    const defaultSetup = path.join(srcDir, "vitest.setup.ts");
    const setupFiles =
      frontend.setupFiles ??
      (existsSync(path.resolve(root, defaultSetup)) ? [`./${defaultSetup}`] : []);
    projects.push({
      extends: true,
      plugins: [react()],
      test: {
        name: "frontend",
        environment: frontend.environment ?? "jsdom",
        include: frontend.include ?? [`${srcDir}/**/*.test.{ts,tsx}`],
        setupFiles,
      },
    });
  }

  const base: UserConfig = {
    resolve: {
      alias: herculesAliases({ root, srcDir, convexDir }),
    },
    test: {
      passWithNoTests: true,
      // Restore mocks before each test to reduce state leaking between tests.
      restoreMocks: true,
      projects,
    },
  };

  return options.vitest ? mergeConfig(base, options.vitest) : base;
}

export default defineVitestConfig;
