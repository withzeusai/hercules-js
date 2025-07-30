import type { Plugin } from "vite";
import { setupErrorHandling } from "./error-handling";

export interface HerculesPluginOptions {
  /**
   * Enable debug logging
   * @default false
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
}

/**
 * Hercules Vite plugin for development workspace integration
 * Handles error reporting and console forwarding for the Hercules platform
 */
export function herculesPlugin(options: HerculesPluginOptions = {}): Plugin {
  const {
    debug = false,
    message = "Hercules plugin is running!",
    handleViteErrors = true
  } = options;

  return {
    name: "vite-plugin-hercules",

    // Plugin hooks for Vite 6
    configResolved(config) {
      if (debug) {
        console.log("[Hercules Plugin] Config resolved:", config.command);
      }
    },

    buildStart() {
      if (debug) {
        console.log(`[Hercules Plugin] ${message}`);
      }
    },

    configureServer(server) {
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
              timestamp: new Date().toISOString()
            })
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
            timestamp: new Date().toISOString()
          });
        }
        throw error;
      }
    },

    transform(_code, id) {
      try {
        // Currently does nothing, but this is where you would transform code
        if (debug && (id.includes(".ts") || id.includes(".js"))) {
          // Just pass through the code unchanged for now
          return null;
        }
        return null; // Explicitly return null to indicate no transformation
      } catch (error: any) {
        if (handleViteErrors) {
          console.error("[Vite Transform Error]", {
            message: error.message,
            stack: error.stack,
            id: id,
            timestamp: new Date().toISOString()
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
            timestamp: new Date().toISOString()
          });
        }
        throw error;
      }
    },

    generateBundle(_options, bundle) {
      if (debug) {
        console.log("[Hercules Plugin] Bundle generated with", Object.keys(bundle).length, "files");
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
            timestamp: new Date().toISOString()
          });
        }
        throw error;
      }
    }
  };
}

// Default export for convenience
export default herculesPlugin;
