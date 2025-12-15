import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/react/index.ts", "src/convex-react/index.ts"],
    external: ["react", "react/jsx-runtime", "convex"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
  },
]);
