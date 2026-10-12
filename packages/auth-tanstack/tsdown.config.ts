import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts", "src/client/index.ts", "src/convex/index.ts"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
  },
]);
