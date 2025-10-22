import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.tsx", "src/convex/index.ts", "src/react.tsx"],
    format: ["cjs", "esm"],
    external: ["react", "react/jsx-runtime"],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: !options.watch,
  },
]);
