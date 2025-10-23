import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/react/index.ts", "src/convex-react/index.ts"],
    format: ["cjs", "esm"],
    external: ["react", "react/jsx-runtime"],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: !options.watch,
  },
]);
