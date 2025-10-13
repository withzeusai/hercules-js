import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: {
      index: "src/index.ts",
      utils: "src/utils.ts",
      types: "src/types.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
  },
]);
