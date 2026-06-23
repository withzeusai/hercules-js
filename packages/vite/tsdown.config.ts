import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
    // src/index.ts intentionally provides both named exports and a
    // default export; "named" silences rolldown's MIXED_EXPORTS warning.
    outputOptions: { exports: "named" },
  },
]);
