import { defineConfig } from "tsdown";

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    // `@usehercules/vite-common` is a devDependency, so tsdown bundles its code
    // and declarations instead of importing the unpublished package. `eager`
    // lets the declaration build emit its files, which sit outside this
    // package's tsconfig. `src/dist.test.ts` checks the result.
    dts: { eager: true },
    sourcemap: true,
    exports: true,
    outputOptions: { exports: "named" },
    ignoreWatch: [".turbo"],
  },
]);
