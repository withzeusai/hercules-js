import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// As the build does: see `tsdown.config.ts`.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __HERCULES_AGENTS_VERSION__: JSON.stringify(version) },
  test: {
    // Type-checks the package and its tests too; `component-api.test-d.ts`
    // holds the hand-kept `ComponentApi` to the component's functions.
    typecheck: { enabled: true, tsconfig: "./tsconfig.test.json" },
  },
});
