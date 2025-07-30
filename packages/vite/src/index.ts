import type { Plugin, ViteDevServer } from 'vite';

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
 * Format Vite error objects into a consistent structure
 */
function formatViteError(error: any): any {
  if (!error) return { message: 'Unknown error', timestamp: new Date().toISOString() };
  
  // Extract the most relevant error information
  const formatted: any = {
    message: error.message || error.reason || 'Unknown error',
    timestamp: new Date().toISOString()
  };

  // Add optional fields if they exist
  if (error.stack) formatted.stack = error.stack;
  if (error.id) formatted.id = error.id;
  if (error.file) formatted.file = error.file;
  if (error.plugin) formatted.plugin = error.plugin;
  if (error.pluginCode) formatted.pluginCode = error.pluginCode;
  if (error.loc) {
    formatted.loc = error.loc;
    formatted.line = error.loc.line;
    formatted.column = error.loc.column;
  }
  if (error.frame) formatted.frame = error.frame;
  if (error.url) formatted.url = error.url;
  if (error.pos !== undefined) formatted.position = error.pos;

  // Include any additional error-specific fields
  if (error.code) formatted.code = error.code;
  if (error.path) formatted.path = error.path;
  
  return formatted;
}

/**
 * Setup error handling for Vite development server
 * Intercepts Vite errors and logs them to console for forwarding to Hercules
 */
function setupErrorHandling(server: ViteDevServer, debug: boolean) {
  if (debug) {
    console.log('[Hercules Plugin] Setting up error handling');
  }

  // Hook into the server's error event
  server.ws.on('error', (error) => {
    if (debug) {
      console.log('[Hercules Plugin] WebSocket error:', error);
    }
    console.error('[Vite Error]', error.message, error.stack);
  });

  // Override the default error handling middleware
  server.middlewares.use((error: any, _req: any, _res: any, next: any) => {
    if (error) {
      // Log the error to console (will be forwarded by console-forwarding script)
      console.error('[Vite Server Error]', formatViteError(error));

      if (debug) {
        console.log('[Hercules Plugin] Intercepted middleware error:', error.message);
      }
    }
    next(error);
  });

  // Hook into HMR update errors and all WebSocket messages
  const originalSend = server.ws.send;
  server.ws.send = function(payload: any) {
    // Handle all error types that Vite sends over WebSocket
    if (payload.type === 'error') {
      // This is the main error that creates the overlay
      const error = payload.err;
      console.error('[Vite Error]', formatViteError(error));

      if (debug) {
        console.log('[Hercules Plugin] Intercepted error overlay:', error?.message);
      }
    } else if (payload.type === 'update' && payload.updates) {
      // Check for errors in module updates
      payload.updates.forEach((update: any) => {
        if (update.type === 'error') {
          console.error('[Vite Module Update Error]', formatViteError(update));
        }
      });
    }
    
    return originalSend.call(this, payload);
  };

  // Handle transform errors
  const originalSsrTransform = server.ssrTransform;
  if (originalSsrTransform) {
    server.ssrTransform = async function(code: string, map: any, url: string, originalCode?: string) {
      try {
        return await originalSsrTransform.call(this, code, map, url, originalCode);
      } catch (error: any) {
        console.error('[Vite Transform Error]', {
          message: error.message,
          stack: error.stack,
          url: url,
          timestamp: new Date().toISOString()
        });
        throw error;
      }
    };
  }

  // Inject client-side script to handle error overlay suppression
  server.middlewares.use('/__hercules_error_handler.js', (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
// Hercules Error Handler - Client Side
(function() {
  'use strict';
  
  // Track if we've already logged an error to prevent duplicates
  const loggedErrors = new WeakSet();
  
  // Helper to extract full error text from overlay
  function extractErrorFromOverlay(overlay) {
    if (!overlay || !overlay.shadowRoot) return null;
    
    const errorData = {
      timestamp: new Date().toISOString()
    };
    
    // Try multiple selectors to capture different error formats
    const messageBody = overlay.shadowRoot.querySelector('.message-body');
    const errorMessage = overlay.shadowRoot.querySelector('.message');
    const file = overlay.shadowRoot.querySelector('.file');
    const frame = overlay.shadowRoot.querySelector('.frame');
    const stack = overlay.shadowRoot.querySelector('.stack');
    
    // Get the main error message
    if (messageBody) {
      errorData.message = messageBody.textContent.trim();
    } else if (errorMessage) {
      errorData.message = errorMessage.textContent.trim();
    }
    
    // Get file information
    if (file) {
      errorData.file = file.textContent.trim();
    }
    
    // Get code frame
    if (frame) {
      errorData.frame = frame.textContent.trim();
    }
    
    // Get stack trace
    if (stack) {
      errorData.stack = stack.textContent.trim();
    }
    
    // If we couldn't find specific elements, get all text content
    if (!errorData.message) {
      const allText = overlay.shadowRoot.textContent;
      if (allText) {
        errorData.message = allText.trim();
      }
    }
    
    return errorData;
  }

  // Override the default error overlay behavior
  if (window.__vite_plugin_react_preamble_installed__) {
    // React-specific error handling
    const originalReactError = window.__vite_plugin_react_preamble_installed__.onError;
    if (originalReactError) {
      window.__vite_plugin_react_preamble_installed__.onError = function(error) {
        // Log to console for Hercules to capture
        if (!loggedErrors.has(error)) {
          loggedErrors.add(error);
          console.error('[React Runtime Error]', {
            message: error.message,
            stack: error.stack,
            componentStack: error.componentStack,
            timestamp: new Date().toISOString()
          });
        }
        
        // Still call original handler
        return originalReactError.call(this, error);
      };
    }
  }

  // Listen for vite error events
  if (typeof window !== 'undefined') {
    window.addEventListener('vite:error', (event) => {
      const error = event.detail || event.error;
      console.error('[Vite Build Error]', {
        message: error?.message || 'Unknown error',
        stack: error?.stack,
        id: error?.id,
        plugin: error?.plugin,
        loc: error?.loc,
        timestamp: new Date().toISOString()
      });
    });

    // Intercept error overlay creation and extract exact content
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName, ...args) {
      const element = originalCreateElement.call(this, tagName, ...args);
      
      if (tagName.toLowerCase() === 'vite-error-overlay') {
        // Hide the overlay
        element.style.display = 'none';
        
        // Use MutationObserver to wait for shadow root and content
        const observer = new MutationObserver(() => {
          if (element.shadowRoot) {
            // Wait a bit for content to be fully rendered
            setTimeout(() => {
              const errorData = extractErrorFromOverlay(element);
              if (errorData && errorData.message) {
                console.error('[Vite Error Overlay]', errorData);
              }
              observer.disconnect();
            }, 50);
          }
        });
        
        observer.observe(element, {
          childList: true,
          subtree: true
        });
        
        // Also try to extract immediately in case shadow root is already there
        setTimeout(() => {
          const errorData = extractErrorFromOverlay(element);
          if (errorData && errorData.message) {
            console.error('[Vite Error Overlay]', errorData);
          }
        }, 0);
      }
      
      return element;
    };
    
    // Also monitor for overlays added via innerHTML or other methods
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === 'VITE-ERROR-OVERLAY') {
            node.style.display = 'none';
            
            setTimeout(() => {
              const errorData = extractErrorFromOverlay(node);
              if (errorData && errorData.message) {
                console.error('[Vite Error Overlay]', errorData);
              }
            }, 50);
          }
        }
      }
    });
    
    // Start observing when DOM is ready
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      });
    }
  }
  
  // Intercept unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Unhandled Promise Rejection]', {
      message: event.reason?.message || String(event.reason),
      stack: event.reason?.stack,
      promise: String(event.promise),
      timestamp: new Date().toISOString()
    });
  });
  
  // Intercept syntax errors and other window errors
  window.addEventListener('error', (event) => {
    // Only log if this isn't already being handled by React
    if (!event.error || !loggedErrors.has(event.error)) {
      if (event.error) loggedErrors.add(event.error);
      
      console.error('[Runtime Error]', {
        message: event.message || event.error?.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
        timestamp: new Date().toISOString()
      });
    }
  });
})();
      `);
    }
  });

  if (debug) {
    console.log('[Hercules Plugin] Error handling setup complete');
  }
}

/**
 * Hercules Vite plugin for development workspace integration
 * Handles error reporting and console forwarding for the Hercules platform
 */
export function herculesPlugin(options: HerculesPluginOptions = {}): Plugin {
  const { 
    debug = false, 
    message = 'Hercules plugin is running!',
    handleViteErrors = true 
  } = options;

  return {
    name: 'vite-plugin-hercules',
    
    // Plugin hooks for Vite 6
    configResolved(config) {
      if (debug) {
        console.log('[Hercules Plugin] Config resolved:', config.command);
      }
    },

    buildStart() {
      if (debug) {
        console.log(`[Hercules Plugin] ${message}`);
      }
    },

    configureServer(server) {
      if (debug) {
        console.log('[Hercules Plugin] Development server configured');
      }
      
      if (handleViteErrors) {
        setupErrorHandling(server, debug);
      }
      
      // Health check endpoint
      server.middlewares.use('/hercules-status', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ 
            status: 'active', 
            plugin: 'hercules',
            timestamp: new Date().toISOString()
          }));
        } else {
          next();
        }
      });
    },

    transformIndexHtml(html) {
      if (handleViteErrors) {
        // Inject our error handling script before any other scripts
        const errorHandlerScript = '<script type="module" src="/__hercules_error_handler.js"></script>';
        
        // Insert before closing head tag, or before first script tag if no head
        if (html.includes('</head>')) {
          return html.replace('</head>', `${errorHandlerScript}\n</head>`);
        } else if (html.includes('<script')) {
          return html.replace('<script', `${errorHandlerScript}\n<script`);
        } else {
          // Fallback: append to end of html
          return html.replace('</html>', `${errorHandlerScript}\n</html>`);
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
          console.error('[Vite Load Error]', {
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
        if (debug && (id.includes('.ts') || id.includes('.js'))) {
          // Just pass through the code unchanged for now
          return null;
        }
        return null; // Explicitly return null to indicate no transformation
      } catch (error: any) {
        if (handleViteErrors) {
          console.error('[Vite Transform Error]', {
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
          console.error('[Vite HMR Update Error]', {
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
        console.log('[Hercules Plugin] Bundle generated with', Object.keys(bundle).length, 'files');
      }
    },

    resolveId(id, importer) {
      // Wrap in try-catch to capture resolution errors
      try {
        return null; // Let Vite handle resolution
      } catch (error: any) {
        if (handleViteErrors) {
          console.error('[Vite Resolution Error]', {
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