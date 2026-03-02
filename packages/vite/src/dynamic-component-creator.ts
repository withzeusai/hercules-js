import type { Plugin } from "vite";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import { constants } from "fs";

export interface DynamicComponentCreatorOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Force enable the plugin even when HERCULES_DEV_MACHINE is not set
   * @default false
   */
  force?: boolean;

  /**
   * Base path for resolving @/ imports
   * @default 'src'
   */
  aliasBase?: string;
}

/**
 * Vite plugin that dynamically creates missing React component files
 * when they are imported but don't exist yet.
 */
export function dynamicComponentCreatorPlugin(
  options: DynamicComponentCreatorOptions = {},
): Plugin {
  const { debug = false, aliasBase = "src" } = options;
  let projectRoot: string;

  return {
    name: "vite-plugin-hercules-dynamic-component-creator",
    enforce: "pre",
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId: {
      order: "pre",
      handler: async (source, importer, _options) => {
        // Only handle relative imports and specific extensions
        if (
          !source.startsWith("./") &&
          !source.startsWith("../") &&
          !source.startsWith("@/")
        )
          return null;
        if (!source.endsWith(".tsx")) return null;

        if (importer) {
          let resolvedPath: string;

          // Handle @/ imports
          if (source.startsWith("@/")) {
            // Replace @/ with the configured base path (default: src)
            const relativePath = source.slice(2); // Remove @/
            resolvedPath = path.resolve(projectRoot, aliasBase, relativePath);
          } else {
            // Handle relative imports as before
            resolvedPath = path.resolve(path.dirname(importer), source);
          }

          // Create parent directory recursively (no-ops if it exists)
          await mkdir(path.dirname(resolvedPath), { recursive: true });

          // Extract file name without extension and convert to component name
          const fileName = path.basename(resolvedPath, '.tsx');

          const toComponentName = (name: string): string => {
            if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name.replace(/[-]/g, ''))) {
              return 'Component';
            }
            return name
              .split(/[-_]/)
              .map(part => part.charAt(0).toUpperCase() + part.slice(1))
              .join('');
          };

          const componentName = toComponentName(fileName);

          try {
            // wx flag: write exclusively — fails with EEXIST if file already exists
            await writeFile(
              resolvedPath,
              `import React from "react";\n\nexport default function ${componentName}(_props: unknown) {\n  return <div></div>;\n}\n`,
              { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL },
            );
            if (debug) {
              const importType = source.startsWith("@/")
                ? "@/ alias"
                : "relative";
              console.log(
                `[Dynamic Component Creator] Created component file from ${importType} import: ${source} -> ${resolvedPath}`,
              );
            }
          } catch (error: any) {
            // EEXIST means the file already exists — not an error, just skip
            if (error?.code !== "EEXIST") throw error;
          }
        }

        return null;
      },
    },
  };
}

// Default export for convenience
export default dynamicComponentCreatorPlugin;
