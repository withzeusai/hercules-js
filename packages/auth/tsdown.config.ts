import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/react/index.ts", "src/convex-react/index.ts"],
    dts: true,
    sourcemap: true,
    exports: true,
    ignoreWatch: [".turbo"],
    define: {
      __HERCULES_AUTH_SDK_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
