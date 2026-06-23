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
  // ESM build for <script type="module"> tags
  {
    ...options,
    outDir: "dist/browser",
    target: "es2022",
    platform: "browser",
    entry: ["src/auto-init.ts"],
    dts: false,
    sourcemap: false,
    minify: true,
    ignoreWatch: [".turbo"],
    deps: {
      alwaysBundle: ["ulid", "web-vitals", "bowser"],
      // Whitelist exactly the deps we intend to inline into the browser
      // script; tsdown errors if anything else gets bundled.
      onlyBundle: ["ulid", "web-vitals", "bowser"],
    },
  },
]);
