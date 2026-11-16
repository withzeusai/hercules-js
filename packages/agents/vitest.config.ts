import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Type-checks the package and its tests too; `component-api.test-d.ts`
    // holds the hand-kept `ComponentApi` to the component's functions.
    typecheck: { enabled: true, tsconfig: "./tsconfig.test.json" },
  },
});
