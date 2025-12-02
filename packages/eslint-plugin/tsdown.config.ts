import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  minify: false,
  exports: true,
  sourcemap: true,
  external: [
    "@typescript-eslint/utils",
    "@typescript-eslint/scope-manager",
    "@typescript-eslint/type-utils",
  ],
});
