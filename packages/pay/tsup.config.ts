import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/convex/index.ts", "src/react.ts"],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
  },
]);
