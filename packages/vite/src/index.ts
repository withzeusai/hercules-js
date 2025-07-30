import type { Plugin } from 'vite';

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
}

/**
 * A dummy Vite plugin for Hercules app
 * This plugin doesn't do anything functional yet, but provides the basic structure
 * for future development.
 */
export function herculesPlugin(options: HerculesPluginOptions = {}): Plugin {
  const { debug = false, message = 'Hercules plugin is running!' } = options;

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
      
      // Example: Add a custom middleware (currently does nothing)
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

    transform(_code, id) {
      // Currently does nothing, but this is where you would transform code
      // Example: Add comments to files
      if (debug && (id.includes('.ts') || id.includes('.js'))) {
        // Just pass through the code unchanged for now
        return null;
      }
      return null; // Explicitly return null to indicate no transformation
    },

    generateBundle(_options, bundle) {
      if (debug) {
        console.log('[Hercules Plugin] Bundle generated with', Object.keys(bundle).length, 'files');
      }
    }
  };
}

// Default export for convenience
export default herculesPlugin; 