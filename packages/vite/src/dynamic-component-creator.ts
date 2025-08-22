import type { Plugin } from "vite";
import path from "path";
import { access, writeFile, mkdir } from "fs/promises";

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
            // Create parent directory recursively if it doesn't exist
            try {
              const parentDir = path.dirname(resolvedPath);
              await mkdir(parentDir, { recursive: true });
            } catch (error) {
              if (debug) {
                console.error("Error creating parent directory", error);
              }
            }

            // Extract file name without extension and convert to component name
            const fileName = path.basename(resolvedPath, '.tsx');
            
            // Convert file name to PascalCase component name if it's a valid identifier
            const toComponentName = (name: string): string => {
              // Check if it's a valid JavaScript identifier
              // Allow names that start with letter or underscore, followed by letters, digits, or underscores
              if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name.replace(/[-]/g, ''))) {
                return 'Component'; // Fallback to generic name if not valid
              }
              
              // Convert kebab-case, snake_case to PascalCase
              return name
                .split(/[-_]/)
                .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                .join('');
            };
            
            const componentName = toComponentName(fileName);

            await writeFile(
              resolvedPath,
              `import React from "react";\n\nexport default function ${componentName}(_props: unknown) {\n  return <div>loading</div>;\n}\n`,
            );
            if (debug) {
              const importType = source.startsWith("@/")
                ? "@/ alias"
                : "relative";
              console.log(
                `[Dynamic Component Creator] Created component file from ${importType} import: ${source} -> ${resolvedPath}`,
              );
            }
          }
        }

        return null;
      },
    },
  };
}

// Default export for convenience
export default dynamicComponentCreatorPlugin;
