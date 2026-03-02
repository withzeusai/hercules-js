import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/react/index.ts", "src/convex-react/index.ts"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
  },
]);
