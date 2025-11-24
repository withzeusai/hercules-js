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
  },
]);
