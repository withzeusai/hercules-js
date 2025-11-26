import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    outDir: "dist/es",
    entry: ["src/index.ts", "src/utils.ts", "src/types.ts", "src/schema.ts"],
    dts: true,
    sourcemap: true,
    ignoreWatch: [".turbo"],
  },
  {
    ...options,
    outDir: "dist/browser",
    format: ["iife"],
    globalName: "HerculesAnalytics",
    target: "es2022",
    platform: "browser",
    entry: ["src/index.ts"],
    minify: true,
    ignoreWatch: [".turbo"],
    noExternal: ["ulid", "web-vitals", "bowser"],
  },
]);
