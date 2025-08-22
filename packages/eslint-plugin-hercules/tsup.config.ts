import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  external: [
    "@typescript-eslint/utils",
    "@typescript-eslint/scope-manager",
    "@typescript-eslint/type-utils",
  ],
});
