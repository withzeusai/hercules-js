import path from "node:path";
import type { Rolldown } from "vite";

/** A relative import that names a compiled addon, such as `../build/Release/cpufeatures.node`. */
const ADDON_FILE = /^\.\.?\/.*\.node$/;

/**
 * Leaves `.node` addon files out of the optimizer bundle. A package can reach
 * one through its own dependencies: `ssh2-sftp-client` loads `ssh2`, which
 * loads `cpu-features`, which requires `../build/Release/cpufeatures.node`.
 * The file is missing when pnpm skips the build script, and the optimizer
 * cannot bundle it when it is there, so the whole run fails and the dev
 * server exits. Kept external, the file is loaded only if that code runs, and
 * `ssh2` loads `cpu-features` inside `try`. A name that resolves to a script,
 * such as `react-dom`'s `./server.node` for `server.node.js`, is bundled as usual.
 */
export function nativeAddonsExternal(): Rolldown.Plugin {
  return {
    name: "hercules:native-addons-external",
    resolveId: {
      filter: { id: ADDON_FILE },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved && !resolved.id.endsWith(".node")) return resolved;
        const file = importer ? path.resolve(path.dirname(importer), source) : source;
        return { id: resolved?.id ?? file, external: true };
      },
    },
  };
}
