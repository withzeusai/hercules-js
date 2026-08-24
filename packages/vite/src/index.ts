import type { Plugin } from "vite";
import { setupErrorHandling } from "./error-handling";
import { componentTaggerPlugin, type ComponentTaggerOptions } from "./component-tagger";
import { visualEditorPlugin, type VisualEditorOptions } from "./visual-editor";
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
   *
   * Tagging attributes (`data-hercules-id` / `data-hercules-name`) are injected
   * on the dev server only; `vite build` output never contains them.
   *
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
  } = options;

  const plugins: Plugin[] = [];

  // Track whether we're in dev mode (for dev-only features like error handler injection)
  let isDev = false;

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

  // Add component tagger plugin if enabled
  if (componentTagger.enabled) {
    plugins.push(
      componentTaggerPlugin({
        debug,
        dataAttribute: visualEditor.enabled ? "data-hercules-id" : "data-component-id",
        ...componentTagger,
      }),
    );
  }

  // Add visual editor plugin if enabled (the plugin itself is `apply: "serve"`)
  if (visualEditor.enabled) {
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
    // Plugin hooks (Vite 7 / 8)
    config(_config, env) {
      // Seed the dependency optimizer from every source file, not just the
      // deps reachable from the entry's static import graph. Large apps import
      // most routes through `lazy(() => import(...))`; deps used only inside
      // those lazy chunks are otherwise discovered when the route is first
      // visited, which forces a mid-session re-optimize + full reload. During
      // that reload some modules stay bound to the previous optimizer
      // generation of React while react-dom loads the new one, so react-dom
      // reads another React instance's internals (null) and crashes in
      // useContext/useMemo. Crawling all of src at startup settles the
      // optimizer once so it never re-bundles mid-session. Only src is scanned,
      // so server-only deps (e.g. under convex/) are never pre-bundled.
      if (env.command !== "serve") return;
      return {
        optimizeDeps: {
          entries: [
            "index.html",
            "src/**/*.{js,jsx,ts,tsx,mjs,mts}",
            "!src/**/*.d.ts",
            "!src/**/*.d.mts",
            "!src/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}",
            "!src/**/__tests__/**",
            "!src/**/__mocks__/**",
          ],
        },
      };
    },
    configResolved(config) {
      // Check if we're in serve (dev) mode vs build mode
      isDev = config.command === "serve";

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
      // Only inject error handler in dev mode
      if (handleViteErrors && isDev) {
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
