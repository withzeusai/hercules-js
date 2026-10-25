import type { Plugin, ViteDevServer } from "vite";

// Import from extracted modules
import { analyzeElement } from "./ast-analyzer";
import { updateComponentElement, deleteComponent } from "./ast-transformer";

export interface VisualEditorOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * The endpoints the visual editor calls to read, update and delete the element
 * behind a `data-hercules-id`. herculesd serves the editor's script and injects
 * it into every page.
 *
 * These endpoints, and the Babel code behind them, are moving into herculesd.
 * Remove them once a dev image with that change ships.
 */
export function visualEditorPlugin(options: VisualEditorOptions = {}): Plugin {
  const { debug = false } = options;
  let server: ViteDevServer;

  return {
    name: "vite-plugin-hercules-visual-editor",
    enforce: "pre",
    apply: "serve",

    configureServer(_server) {
      server = _server;

      // Handle unified element analysis requests
      server.middlewares.use("/__hercules_analyze_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const { componentId } = JSON.parse(body);

              const result = await analyzeElement(componentId, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error analyzing element:", error);
              }
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
        } else {
          next();
        }
      });

      // Handle unified element update requests
      server.middlewares.use("/__hercules_update_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId, className, textContent } = data;

              const updates: { className?: string; textContent?: string } = {};
              if (className !== undefined) updates.className = className;
              if (textContent !== undefined) updates.textContent = textContent;

              const result = await updateComponentElement(componentId, updates, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error updating element:", error);
              }
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
        } else {
          next();
        }
      });

      // Handle element deletion requests
      server.middlewares.use("/__hercules_delete_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId } = data;

              const result = await deleteComponent(componentId, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error deleting element:", error);
              }
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
        } else {
          next();
        }
      });
    },
  };
}
