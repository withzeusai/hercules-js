import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
  },
]);
