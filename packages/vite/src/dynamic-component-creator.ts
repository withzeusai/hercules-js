import type { Plugin } from "vite";
import path from "path";
import { writeFile, mkdir, link, rm, access } from "fs/promises";
import { constants } from "fs";
import { randomUUID } from "crypto";

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

async function createFileExclusively(filePath: string, content: string): Promise<boolean> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, { flag: "wx" });
    try {
      await link(tempPath, filePath);
      return true;
    } catch (error: any) {
      if (error?.code === "EEXIST") return false;
      if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
    }
  } finally {
    await rm(tempPath, { force: true });
  }
  try {
    await writeFile(filePath, content, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    });
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
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
        if (!source.startsWith("./") && !source.startsWith("../") && !source.startsWith("@/"))
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
          const fileName = path.basename(resolvedPath, ".tsx");

          const toComponentName = (name: string): string => {
            if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name.replace(/[-]/g, ""))) {
              return "Component";
            }
            return name
              .split(/[-_]/)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join("");
          };

          const componentName = toComponentName(fileName);

          const exists = await access(resolvedPath).then(
            () => true,
            () => false,
          );
          const created =
            !exists &&
            (await createFileExclusively(
              resolvedPath,
              `import React from "react";\n\nexport default function ${componentName}(_props: unknown) {\n  return <div></div>;\n}\n`,
            ));
          if (created && debug) {
            const importType = source.startsWith("@/") ? "@/ alias" : "relative";
            console.log(
              `[Dynamic Component Creator] Created component file from ${importType} import: ${source} -> ${resolvedPath}`,
            );
          }
        }

        return null;
      },
    },
  };
}

// Default export for convenience
export default dynamicComponentCreatorPlugin;
