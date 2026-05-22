import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentMatchGlobs: [["src/component/**/*.test.ts", "edge-runtime"]],
    server: { deps: { inline: ["convex-test"] } },
  },
});
