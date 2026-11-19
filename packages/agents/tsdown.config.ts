import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsdown";

const COMPONENT_OUT = "dist/component";

// The one place the package's version comes from. The build writes it into
// the code that names the package to Hercules, so the two cannot differ.
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const define = { __HERCULES_AGENTS_VERSION__: JSON.stringify(version) };
const ROLLDOWN_RUNTIME = join(COMPONENT_OUT, "_virtual");

/**
 * Rolldown writes its runtime helpers next to the modules even when none
 * imports them. Convex would ship that file as a module of the component, so
 * it goes, unless a module does use it.
 */
function dropUnusedRuntime() {
  const used = readdirSync(COMPONENT_OUT, { recursive: true, encoding: "utf8" }).some(
    (file) =>
      file.endsWith(".js") &&
      !file.startsWith("_virtual") &&
      readFileSync(join(COMPONENT_OUT, file), "utf8").includes("_virtual/"),
  );
  if (!used) rmSync(ROLLDOWN_RUNTIME, { recursive: true, force: true });
}

export default defineConfig((options) => [
  {
    ...options,
    entry: ["src/index.ts", "src/convex.ts", "src/react.ts", "src/tanstack.ts"],
    define,
    dts: true,
    sourcemap: true,
    ignoreWatch: [".turbo"],
  },
  // The Convex component ships as one module per file, with `.js` names:
  // Convex finds `convex.config.js` and `schema.js` by name and bundles the
  // directory's other modules itself.
  {
    ...options,
    entry: ["src/component/**/*.ts"],
    unbundle: true,
    root: "src/component",
    outDir: COMPONENT_OUT,
    fixedExtension: false,
    clean: false,
    define,
    dts: true,
    sourcemap: true,
    ignoreWatch: [".turbo"],
    onSuccess: dropUnusedRuntime,
  },
]);
