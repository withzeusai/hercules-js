import type { Plugin } from "vite";
import { setupErrorHandling } from "./error-handling";
import {
  componentTaggerPlugin,
  type ComponentTaggerOptions,
} from "./component-tagger";
import { visualEditorPlugin, type VisualEditorOptions } from "./visual-editor";
import { bannerPlugin, type BannerPluginOptions } from "./banner";
import {
  dynamicComponentCreatorPlugin,
  type DynamicComponentCreatorOptions,
} from "./dynamic-component-creator";

export interface HerculesPluginOptions {
  /**
   * Enable debug logging
   * @default true
   */
  debug?: boolean;

  /**
   * Custom message to log during build
   * @default 'Hercules plugin is running!'
   */
  message?: string;

  /**
   * Enable Vite error handling and console logging
   * @default true
   */
  handleViteErrors?: boolean;

  /**
   * Component tagger options
   * @default { enabled: true }
   */
  componentTagger?: ComponentTaggerOptions & { enabled?: boolean };

  /**
   * Visual editor options
   * @default { enabled: true }
   */
  visualEditor?: VisualEditorOptions & { enabled?: boolean };

  /**
   * Dynamic component creator options
   * Note: Only active when HERCULES_DEV_MACHINE environment variable is set,
   * unless 'force' option is true
   * @default { enabled: true }
   */
  dynamicComponentCreator?: DynamicComponentCreatorOptions & {
    enabled?: boolean;
  };

  /**
   * Banner options for displaying "Powered by Hercules"
   * @default { enabled: true }
   */
  banner?: BannerPluginOptions & { enabled?: boolean };
}

/**
 * Hercules Vite plugin for development workspace integration
 * Handles error reporting and console forwarding for the Hercules platform
 */
export function hercules(options: HerculesPluginOptions = {}): Plugin[] {
  const {
    debug = false,
    message = "Hercules plugin is running!",
    handleViteErrors = true,
    componentTagger = { enabled: true },
    visualEditor = { enabled: true },
    dynamicComponentCreator = { enabled: true },
    banner = { enabled: true },
  } = options;

  const plugins: Plugin[] = [];

  // Dynamic component creator plugin (only when on Hercules dev machine or forced)
  if (
    dynamicComponentCreator.enabled &&
    (process.env.HERCULES_DEV_MACHINE || dynamicComponentCreator.force)
  ) {
    plugins.push(
      dynamicComponentCreatorPlugin({
        debug,
        ...dynamicComponentCreator,
      }),
    );
  }

  // Add banner plugin if enabled
  if (banner.enabled) {
    plugins.push(
      bannerPlugin({
        debug,
        ...banner,
      }),
    );
  }

  // Add component tagger plugin if enabled
  if (componentTagger.enabled) {
    plugins.push(
      componentTaggerPlugin({
        debug,
        dataAttribute: visualEditor.enabled
          ? "data-hercules-id"
          : "data-component-id",
        ...componentTagger,
      }),
    );
  }

  // Add visual editor plugin if enabled (dev mode only)
  if (visualEditor.enabled && process.env.NODE_ENV !== "production") {
    plugins.push(
      visualEditorPlugin({
        debug,
        dataAttribute: "data-hercules-id",
        ...visualEditor,
      }),
    );
  }

  // Main Hercules plugin
  plugins.push({
    name: "vite-plugin-hercules",
    // Plugin hooks for Vite 6
    configResolved(config) {
      if (debug) {
        console.log("[Hercules Plugin] Config resolved:", config.command);
      }
    },

    async buildStart() {
      if (debug) {
        console.log(`[Hercules Plugin] ${message}`);
      }
    },

    async configureServer(server) {
      if (debug) {
        console.log("[Hercules Plugin] Development server configured");
      }

      if (handleViteErrors) {
        setupErrorHandling(server, debug);
      }

      // Health check endpoint
      server.middlewares.use("/hercules-status", (req, res, next) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              status: "active",
              plugin: "hercules",
              timestamp: new Date().toISOString(),
            }),
          );
        } else {
          next();
        }
      });
    },

    transformIndexHtml(html) {
      if (handleViteErrors) {
        // Inject our error handling script before any other scripts
        const errorHandlerScript =
          '<script type="module" src="/__hercules_error_handler.js"></script>';

        // Insert before closing head tag, or before first script tag if no head
        if (html.includes("</head>")) {
          return html.replace("</head>", `${errorHandlerScript}\n</head>`);
        } else if (html.includes("<script")) {
          return html.replace("<script", `${errorHandlerScript}\n<script`);
        } else {
          // Fallback: append to end of html
          return html.replace("</html>", `${errorHandlerScript}\n</html>`);
        }
      }
      return html;
    },

    load(id) {
      try {
        // Let Vite handle loading normally
        return null;
      } catch (error: any) {
        if (handleViteErrors) {
          console.error("[Vite Load Error]", {
            message: error.message,
            stack: error.stack,
            id: id,
            timestamp: new Date().toISOString(),
          });
        }
        throw error;
      }
    },

    async transform(_code, id) {
      try {
        // Pass through unchanged - component tagging is handled by separate plugin
        return null;
      } catch (error: any) {
        if (handleViteErrors) {
          console.error("[Vite Transform Error]", {
            message: error.message,
            stack: error.stack,
            id: id,
            timestamp: new Date().toISOString(),
          });
        }
        throw error;
      }
    },

    handleHotUpdate(ctx) {
      try {
        // Let Vite handle the update normally
        return undefined;
      } catch (error: any) {
        if (handleViteErrors) {
          console.error("[Vite HMR Update Error]", {
            message: error.message,
            stack: error.stack,
            file: ctx.file,
            timestamp: new Date().toISOString(),
          });
        }
        throw error;
      }
    },

    generateBundle(_options, bundle) {
      if (debug) {
        console.log(
          "[Hercules Plugin] Bundle generated with",
          Object.keys(bundle).length,
          "files",
        );
      }
    },

    resolveId(id, importer) {
      // Wrap in try-catch to capture resolution errors
      try {
        return null; // Let Vite handle resolution
      } catch (error: any) {
        if (handleViteErrors) {
          console.error("[Vite Resolution Error]", {
            message: error.message,
            stack: error.stack,
            id: id,
            importer: importer,
            timestamp: new Date().toISOString(),
          });
        }
        throw error;
      }
    },
  });

  return plugins;
}

// Re-export plugins for standalone use
export {
  dynamicComponentCreatorPlugin,
  type DynamicComponentCreatorOptions,
} from "./dynamic-component-creator";

// Default export for convenience
export default hercules;
