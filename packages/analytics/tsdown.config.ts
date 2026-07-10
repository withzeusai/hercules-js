import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// Injected into src/lib-version.ts so events report the published client version
const define = {
  __LIB_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig((options) => [
  {
    ...options,
    outDir: "dist/es",
    entry: ["src/index.ts", "src/utils.ts", "src/types.ts", "src/schema.ts"],
    dts: true,
    sourcemap: true,
    define,
    ignoreWatch: [".turbo"],
  },
  // ESM build for <script type="module"> tags
  {
    ...options,
    outDir: "dist/browser",
    target: "es2022",
    platform: "browser",
    entry: ["src/auto-init.ts"],
    dts: false,
    sourcemap: false,
    minify: true,
    define,
    ignoreWatch: [".turbo"],
    deps: {
      alwaysBundle: ["ulid", "web-vitals"],
    },
  },
]);
