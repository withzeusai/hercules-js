import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts", "src/convex.ts"],
    dts: true,
    sourcemap: true,
    ignoreWatch: [".turbo"],
  },
]);
