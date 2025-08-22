import type { Plugin } from "vite";
import path from "path";
import { access, writeFile } from "fs/promises";

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
}

/**
 * Vite plugin that dynamically creates missing React component files
 * when they are imported but don't exist yet.
 */
export function dynamicComponentCreatorPlugin(
  options: DynamicComponentCreatorOptions = {}
): Plugin {
  const { debug = false } = options;

  return {
    name: "vite-plugin-hercules-dynamic-component-creator",
    resolveId: async (source, importer, _options) => {
      // Only handle relative imports and specific extensions
      if (!source.startsWith("./") && !source.startsWith("../")) return null;
      if (!source.endsWith(".tsx")) return null;

      if (importer) {
        const resolvedPath = path.resolve(path.dirname(importer), source);

        // Helper function to check if file exists
        const exists = async (filePath: string): Promise<boolean> => {
          try {
            await access(filePath);
            return true;
          } catch {
            return false;
          }
        };

        if (!(await exists(resolvedPath))) {
          await writeFile(
            resolvedPath,
            'import React from "react";\n\nconst Component: React.FC = (_props: unknown) => <></>;\n\nexport default Component;'
          );
          if (debug) {
            console.log(
              `[Dynamic Component Creator] Created component file: ${resolvedPath}`
            );
          }
        }
      }

      return null;
    },
  };
}

// Default export for convenience
export default dynamicComponentCreatorPlugin;
