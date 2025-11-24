import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.tsx", "src/convex/index.ts", "src/react.tsx"],
    external: ["react", "react/jsx-runtime"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
  },
]);
